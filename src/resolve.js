// Turn a file-host landing page into a real, direct file URL.
//
// How the host works (confirmed by inspecting the live page):
//   - The landing page is behind Cloudflare and renders a Turnstile widget.
//   - A real Chrome session is issued a Turnstile token automatically, with no
//     user interaction, a few seconds after load.
//   - The DOWNLOAD control then POSTs to /f/<id>/go with that token, and the
//     response carries the direct file URL.
//   - Clicking the control also spawns advertising pop-unders. We therefore
//     replay the same POST ourselves instead of clicking, which is faster and
//     skips the ads entirely.
//
// Direct URLs from this host are short-lived and IP-bound, so callers must
// resolve just before queueing, not all upfront.

import path from 'node:path';
import { chromium } from 'playwright-core';
import { safeUrl } from './safe.js';

const DEFAULT_PROFILE = path.resolve('browser-profile');

export class ResolveError extends Error {}

/** Open one shared browser for the whole run. */
export async function openBrowser({
  profileDir = DEFAULT_PROFILE,
  headless = false,
} = {}) {
  return chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless,
    viewport: { width: 1280, height: 900 },
    // Without this, Turnstile never issues a token to the automated session.
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

function isDirectFileUrl(candidate, pageHost) {
  const url = safeUrl(candidate);
  if (!url) return null;
  const u = new URL(url);
  if (u.host === pageHost) return null;
  if (u.host.endsWith('cloudflare.com')) return null;
  return url;
}

/**
 * Give Chrome a chance to be issued its Turnstile token.
 *
 * Not fatal if none arrives: once the profile holds a clearance cookie the host
 * accepts the request without a fresh token, so we let the POST be the judge.
 */
async function waitForToken(page, waitMs = 25000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(() => Boolean(window.turnstileToken || window.dlCleared))
      .catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

/** Ask the host for the direct URL, the same way its own button does. */
async function requestDirectUrl(page) {
  return page.evaluate(async () => {
    const id = location.pathname.split('/').filter(Boolean)[0];
    const body = new URLSearchParams({
      'cf-turnstile-response': window.turnstileToken || '',
    });
    const res = await fetch(`/f/${id}/go`, {
      method: 'POST',
      body,
      headers: { 'HX-Request': 'true' },
    });
    return {
      status: res.status,
      // The host returns the direct URL as an htmx redirect header; the body
      // is just "OK".
      redirect: res.headers.get('hx-redirect') || '',
      text: await res.text(),
    };
  });
}

/** Pull the first plausible file URL out of the host's response body. */
function pickUrlFromResponse(text, pageHost) {
  try {
    const json = JSON.parse(text);
    for (const key of ['url', 'link', 'download', 'direct']) {
      const hit = isDirectFileUrl(json?.[key], pageHost);
      if (hit) return hit;
    }
  } catch {
    // not JSON; fall through to a plain scan
  }
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
    const hit = isDirectFileUrl(match[0], pageHost);
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolve one landing page to { url, cookie, userAgent, referer }.
 * Throws ResolveError with a readable reason on failure.
 */
export async function resolveLink(context, pageUrl, { timeoutMs = 90000 } = {}) {
  const page = await context.newPage();
  const pageHost = new URL(pageUrl).host;

  try {
    await page.goto(pageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    const hadToken = await waitForToken(page);

    const res = await requestDirectUrl(page);
    if (res.status === 404 || res.status === 410) {
      throw new ResolveError('link is dead or expired (host replied 404)');
    }
    if (res.status !== 200) {
      throw new ResolveError(
        hadToken
          ? `host replied HTTP ${res.status}`
          : `host replied HTTP ${res.status} and issued no token — open the site in Chrome once by hand`,
      );
    }

    const url =
      isDirectFileUrl(res.redirect, pageHost) ??
      pickUrlFromResponse(res.text, pageHost);
    if (!url) {
      throw new ResolveError('host reply contained no direct file URL');
    }

    const userAgent = await page
      .evaluate(() => navigator.userAgent)
      .catch(() => '');

    return {
      url,
      userAgent,
      referer: pageUrl,
      ...(await probeFile(context, url, userAgent)),
    };
  } catch (err) {
    throw err instanceof ResolveError ? err : new ResolveError(err.message);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Ask the storage node for the file's real size and name.
 *
 * A one-byte range request is enough and costs nothing. Knowing the exact size
 * lets the scheduler tell "finished" from "stalled" without guessing.
 */
async function probeFile(context, url, userAgent) {
  try {
    const res = await context.request.fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0', 'User-Agent': userAgent },
      timeout: 30000,
    });
    const range = res.headers()['content-range'] ?? '';
    const total = Number(range.split('/')[1]);

    const disposition = res.headers()['content-disposition'] ?? '';
    const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);

    return {
      size: Number.isFinite(total) && total > 0 ? total : null,
      serverFilename: match ? decodeURIComponent(match[1]) : null,
      resumable: res.status() === 206,
    };
  } catch {
    return { size: null, serverFilename: null, resumable: false };
  }
}

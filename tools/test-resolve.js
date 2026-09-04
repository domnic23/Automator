// Manual check: resolve one landing page and print the direct URL.
// Usage: node tools/test-resolve.js <page-url>

import { openBrowser, resolveLink } from '../src/resolve.js';

const target = process.argv[2];
if (!target) {
  console.error('usage: node tools/test-resolve.js <page-url>');
  process.exit(1);
}

const context = await openBrowser({ headless: false });
try {
  const out = await resolveLink(context, target);
  console.log('DIRECT URL :', out.url.slice(0, 90) + '...');
  console.log('SIZE       :', out.size, `(${(out.size / 1e6).toFixed(1)} MB)`);
  console.log('SERVER NAME:', out.serverFilename);
  console.log('RESUMABLE  :', out.resumable);
} catch (err) {
  console.error('FAILED:', err.message);
} finally {
  await context.close();
}

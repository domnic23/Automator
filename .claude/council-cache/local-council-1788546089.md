# Local council — tech stack for Automator

**Local council** — these perspectives all come from Claude playing different
roles, not from different AI vendors. Treat agreement as a shared starting point
to pressure-test, not as independent confirmation.

Roles: Devil's Advocate, Simplicity Champion, Security Auditor, Scalability Architect.

## Devil's Advocate
The language choice is a distraction. The real risk is that the paste site or the
file host changes and breaks the pipeline. A headless browser is more durable
than a hand-written crypto reimplementation. IDM's completion signal is
undocumented and version-dependent, so any detector will need babysitting.

## Simplicity Champion
Do not build a job framework. Completion detection is filesystem polling, so the
scheduler is a while loop. PowerShell is already installed and .NET gives it
AES-GCM and DeflateStream for free. Do not over-build logging for a personal tool.

## Security Auditor
Windows has no real argv — every process gets one string it re-parses. Paste
content becomes a filename and a command argument, so string-built command lines
allow switch injection. Use a stack with a true argument array (.NET
ArgumentList, Go exec.Command, Node execFile). Also: sanitize filenames against
path traversal, allow only http/https, and cap zlib inflate against a
decompression bomb.

## Scalability Architect
Completion detection is the real constraint, not language. Use one poll loop and
a bounded slot pool, not N watchers. Add a per-item timeout or one dead link
holds a slot for the whole run. IDM has its own global simultaneous-download cap
that can silently sit below the requested N.

## Synthesis

**Shared starting point:** all four treat "knowing when IDM finished" as the
weak link. That is a common prior worth stress-testing — it turned out to be
solvable exactly, by asking the storage node for the file's byte size up front
and comparing against the file on disk.

**Genuine tension:** Simplicity said PowerShell; Security said PowerShell is the
worst option here specifically because of command-line string building. With 112
attacker-supplied filenames, Security wins.

**Blind spot no member covered:** none of them checked whether the paste links
were direct downloads. They are not — they are Cloudflare-gated landing pages,
which changes the design more than the language choice does.

**Direction taken:** Node.js 22 with plain JavaScript. Zero dependencies for
decryption (proven working), `playwright-core` for link resolution, `execFile`
with an argument array for IDM safety, a single poll loop with a bounded slot
pool, per-item stall and start timeouts, and an append-only JSONL run log.

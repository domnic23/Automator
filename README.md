# Automator

Reads a paste full of download links and drives Internet Download Manager
through them, N at a time.

## What it does

1. Opens the paste. The paste is encrypted; the key is in the URL after `#`.
   Automator decrypts it locally.
2. Reads the download links out of it.
3. For each link, opens the file host page in Chrome to get the real file URL.
   The host is behind Cloudflare, so a plain fetch is not enough.
4. Hands the real URL to IDM.
5. Keeps exactly N downloads going. When one finishes, the next starts at once.
6. Writes every result to a log, so you can print a table afterwards.

## Setup

```
npm install
```

You need Node 22 or newer, Google Chrome, and IDM installed.

Check IDM is reachable:

```
node tools/probe-idm.js
```

## Use

```
node src/cli.js run "<paste-url>" --max 3 --dir "D:\Games"
```

The first run opens a visible Chrome window. Leave it alone — it needs to be
seen by the file host. After that you can add `--headless`.

Stop any time with Ctrl+C. Run the same command again to carry on where it
stopped. Finished files are not downloaded twice.

## Other commands

```
node src/cli.js links   "<paste-url>"      list the links, download nothing
node src/cli.js resolve "<page-url>"       test one link
node src/cli.js report                     print a table of the last run
node src/cli.js report --csv               same, as CSV
```

## Options

| Option | Meaning | Default |
|---|---|---|
| `--max <n>` | how many downloads at once | 3 |
| `--dir <path>` | where to save | `.\downloads` |
| `--idm <path>` | full path to IDMan.exe | auto |
| `--password <s>` | paste password, if it has one | none |
| `--headless` | hide the browser | off |
| `--stall <min>` | give up after this many idle minutes | 30 |

## Notes

- IDM has its own limit on simultaneous downloads. If it is lower than
  `--max`, the extra jobs just wait inside IDM.
- Run logs live in `state/`. One file per paste.
- If the paste site or the file host changes, Automator stops with a clear
  message saying which step broke.

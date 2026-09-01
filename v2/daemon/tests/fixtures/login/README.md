# Login CLI fixtures

Redacted captures of what each vendor's **real** login command prints, used
by `../../login-cues.test.ts` to validate the recipe cues in
`v2/core/src/accountRecipes.ts` against actual output (chunk boundaries,
ANSI, redraws included) instead of the fake CLI.

Capture (macOS; runs the CLI in an isolated home, never completes a login,
opens no browser):

```sh
node scripts/capture-login-fixture.ts codex codex-browser --ms 8000
node scripts/capture-login-fixture.ts codex codex-device  --ms 8000
node scripts/capture-login-fixture.ts grok  grok-cli      --ms 12000
node scripts/capture-login-fixture.ts kimi  kimi-cli      --ms 25000   # kimi takes ~16 s to print
```

Each fixture records the command, backend (`pty` via script(1) or `pipe`),
CLI version, capture date, the raw chunks with timestamps, what the parser
saw at capture time (`parsed`) and the hand-checked truth (`expect`). Check
`expect` against the raw text before committing a re-capture.

Redaction is in place and shape-preserving: URL query values for
state / code / challenge / nonce / device / user / session / token keys are
`x`-filled, device codes become `XXXX-0000`-shaped, and the temp home,
`$HOME`, hostname, user name and e-mail addresses are replaced. The test
asserts none survived.

| fixture | captured with | what it proves |
|---|---|---|
| `codex-codex-browser` | codex-cli 0.149.1 | the first URL is the loopback server (`http://localhost:1455`) — the cue must be https-only |
| `codex-codex-device` | codex-cli 0.149.1 | the one-time code sits on the line after "Enter this one-time code (expires …)" |
| `grok-grok-cli` | grok 1.0.5 | `grok login` uses a `127.0.0.1:<port>/callback` redirect (not remote-capable) and asks "Paste the URL here if it doesn't connect:" |
| `kimi-kimi-cli` | kimi 0.34.0 | `kimi login` is a device-code flow: authorize URL with `user_code=` + the code on the next line |

Owed: `cursor/cursor-browser` — `cursor-agent login` needs the Cursor IDE
installed and an unlocked login keychain, so it must be captured by hand on a
Cursor machine (`node scripts/capture-login-fixture.ts cursor cursor-browser`).

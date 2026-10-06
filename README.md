# pi-jev-router

A [pi coding agent](https://github.com/earendil-works/pi) extension that routes every request to the right Claude model automatically, using the **Jev** classifier from TypeSafe.

Four Azure-hosted Claude deployments sit behind a single virtual model called `jev/auto`:

| Tier | Model | When |
|---|---|---|
| ⚡ trivial | claude-haiku-4-5 | Quick questions, one-liners, renames |
| 🔵 standard | claude-sonnet-4-6 | Ordinary features, bug fixes, code review |
| 🟠 complex | claude-opus-5-5 | Subtle design, cross-cutting changes, hard debugging |
| 🔴 frontier | claude-fable-5-1 | Research-grade work, long autonomous tasks |

You pay for the cheapest model that can actually do the job, and the router escalates automatically when the agent gets stuck.

## How it works

### On every user message

Jev reads your message (plus a little earlier context) and picks the tier. You see a toast notification so you know which model was chosen:

```
🔵 jev → standard (claude-sonnet-4-6)
```

### Inside the agent loop (escalation only)

While the agent is working, the router watches for trouble:

- **2 or more** of the last 6 tool results failed (errors, failing tests, broken builds), or
- the agent edited the **same file 3 or more times** in the same turn.

When trouble is detected, and at least **5 steps** have passed since the last check, Jev is asked "which tier does the next step need?" It sees the original task, the failing output, and the model's latest message. The router escalates **only if Jev answers with ≥ 70% confidence**.

When it escalates you see:

```
🟠 jev ↑ complex (claude-opus-5-5) — 6 failing tool results in the last 6
```

The router **never de-escalates mid-turn** — switching to a cheaper model causes a full prompt-cache miss and rarely saves money once the context is long. A new message from you can start fresh on any tier.

Retries (provider timeouts, overloads) stay on the same model; they are not a sign the task is hard.

### State

The current tier is stored as router state on the session branch. It survives compaction and follows forks of the session tree. The step counter resets at the start of each user turn.

## Prerequisites

| Requirement | Notes |
|---|---|
| **pi coding agent** | Tested with pi ≥ 0.170 |
| **TYPESAFE_API_KEY** | For the Jev classifier |
| **`azure-foundry-anthropic` provider** | Configure in `~/.pi/agent/models.json` with the four Claude deployments |

The four model IDs the router expects:

```
claude-haiku-4-5
claude-sonnet-4-6
claude-opus-5-5
claude-fable-5-1
```

Change the `TIERS` map at the top of `extensions/jev-router.ts` if your deployment IDs differ.

## Installation

```bash
# Clone this repo
git clone https://github.com/AI4Belgium/pi-jev-router
cd pi-jev-router

# Copy the extension to your pi user extensions directory
cp extensions/jev-router.ts ~/.pi/agent/extensions/

# Start pi with the jev/auto virtual model
pi --model jev/auto
```

The extension loads automatically on every subsequent `pi` start; no `--extension` flag needed.

## Tuning

Constants at the top of `extensions/jev-router.ts`:

| Constant | Default | What it controls |
|---|---|---|
| `CHECK_EVERY` | `5` | Minimum loop steps between two in-loop Jev checks |
| `RECENT_RESULTS` | `6` | How many recent tool results to scan for trouble |
| `ERROR_THRESHOLD` | `2` | Failing results (out of `RECENT_RESULTS`) that count as struggling |
| `SAME_FILE_EDITS` | `3` | Edits to one file in a turn that count as churning |
| `MIN_CONFIDENCE` | `0.7` | Jev probability required before escalating |
| `DIRECT_TIER` | `"standard"` | Tier used for compaction summaries and extension calls |

Raise `MIN_CONFIDENCE` (e.g. `0.85`) to escalate less aggressively. Lower `CHECK_EVERY` (e.g. `3`) to react faster.

## Notifications

Every routing decision fires a pi toast notification:

| Situation | Notification |
|---|---|
| New user message | `🔵 jev → standard (claude-sonnet-4-6)` |
| In-loop escalation | `🟠 jev ↑ complex (claude-opus-5-5) — 6 failing tool results in the last 6` |

Notifications only appear in interactive mode (`pi` TUI). They are suppressed in JSON and RPC modes.

## Development

Type-check with the pi bundled TypeScript compiler:

```bash
PI=$(npm root -g)/@earendil-works/pi-coding-agent
mkdir -p /tmp/jevcheck && cd /tmp/jevcheck
mkdir -p node_modules/@earendil-works
ln -sf $PI node_modules/@earendil-works/pi-coding-agent
ln -sf $PI/node_modules/@earendil-works/pi-ai node_modules/@earendil-works/pi-ai
cp /path/to/jev-router.ts .
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2023", "module": "NodeNext",
    "moduleResolution": "NodeNext", "strict": true,
    "noEmit": true, "skipLibCheck": true, "lib": ["ES2023"]
  },
  "files": ["jev-router.ts"]
}
EOF
$PI/node_modules/.bin/tsc -p .
```

## License

MIT

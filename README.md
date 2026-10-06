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

---

## How it works

### On every user message

Jev reads your message (plus a little earlier context) and picks the tier. A toast notification confirms which model was chosen:

```
🔵 jev → standard (claude-sonnet-4-6)
```

### Inside the agent loop — escalation only

While the agent is working, the router watches for trouble:

- **2 or more** of the last 6 tool results failed (errors, failing tests, broken builds), **or**
- the agent edited the **same file 3 or more times** in the same turn.

When trouble is detected, and at least **5 steps** have passed since the last check, Jev is asked:
> *"Which tier does the next step need?"*

It sees the original task, the failing output, and the model's latest message.  
The router escalates **only when Jev answers with ≥ 70 % confidence**.

```
🟠 jev ↑ complex (claude-opus-5-5) — 6 failing tool results in the last 6
```

The router **never de-escalates mid-turn** — switching to a cheaper model causes a full prompt-cache miss and rarely saves money once the context is long. A new message from you can start fresh at any tier.

Retries (provider timeouts, overloads) stay on the same model — they are not a sign the task is hard.

### State and session trees

The current tier is stored as router state on the session branch. It survives compaction and follows `/tree` forks automatically. The step counter resets at the start of each new user message.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **pi coding agent** | Install from [pi.dev](https://pi.dev). Tested with pi ≥ 0.170. |
| **Azure AI Foundry access** | A project with the four Claude models deployed (see below). |
| **TypeSafe API key** | For the Jev classifier — sign up at [typesafe.sh](https://typesafe.sh). |

---

## Setup

### 1 — Get a TypeSafe API key

Sign up at **[typesafe.sh](https://typesafe.sh)** and copy your API key.  
Export it in your shell profile so pi can find it:

```bash
# ~/.zshrc or ~/.bashrc
export TYPESAFE_API_KEY="ts-..."
```

Pi reads this at start-up. No other configuration is needed for the Jev classifier.

### 2 — Deploy the four Claude models on Azure AI Foundry

In the [Azure AI Foundry portal](https://ai.azure.com):

1. Open (or create) a project.
2. Go to **Models + endpoints → Deploy model**.
3. Deploy each of the four models below. Note the **endpoint URL** and **API key** for your project (they are shared across all deployments in a project).

| Deployment name | Base model |
|---|---|
| `claude-haiku-4-5` | Claude Haiku 4.5 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `claude-opus-5-5` | Claude Opus 5.5 |
| `claude-fable-5-1` | Claude Fable 5.1 |

> **Tip:** Use exactly these deployment names. If you use different names, update the `TIERS` map at the top of `extensions/jev-router.ts` to match.

### 3 — Configure `~/.pi/agent/models.json`

Pi uses `models.json` to register custom providers and endpoints.  
Open (or create) `~/.pi/agent/models.json` and add the `azure-foundry-anthropic` provider:

```json
{
  "providers": {
    "azure-foundry-anthropic": {
      "baseUrl": "https://<your-project>.services.ai.azure.com/models",
      "api": "anthropic-messages",
      "apiKey": "<your-azure-foundry-api-key>",
      "models": [
        {
          "id": "claude-haiku-4-5",
          "name": "Claude Haiku 4.5 (Azure Foundry)",
          "contextWindow": 200000,
          "maxTokens": 16000,
          "input": ["text", "image"],
          "reasoning": true,
          "compat": { "supportsStrictTools": true },
          "cost": { "input": 1, "output": 5, "cacheRead": 0.1, "cacheWrite": 1.25 }
        },
        {
          "id": "claude-sonnet-4-6",
          "name": "Claude Sonnet 4.6 (Azure Foundry)",
          "contextWindow": 1000000,
          "maxTokens": 64000,
          "input": ["text", "image"],
          "reasoning": true,
          "compat": { "forceAdaptiveThinking": true, "supportsStrictTools": true },
          "cost": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
        },
        {
          "id": "claude-opus-5-5",
          "name": "Claude Opus 5.5 (Azure Foundry)",
          "contextWindow": 1000000,
          "maxTokens": 32000,
          "input": ["text", "image"],
          "reasoning": true,
          "compat": {
            "forceAdaptiveThinking": true,
            "supportsStrictTools": true,
            "supportsMidConvoEffort": true
          },
          "cost": { "input": 4, "output": 20, "cacheRead": 0.2, "cacheWrite": 5 }
        },
        {
          "id": "claude-fable-5-1",
          "name": "Claude Fable 5.1 (Azure Foundry)",
          "contextWindow": 1000000,
          "maxTokens": 128000,
          "input": ["text", "image"],
          "reasoning": true,
          "compat": { "forceAdaptiveThinking": true, "supportsStrictTools": true },
          "cost": { "input": 10, "output": 50, "cacheRead": 0.25, "cacheWrite": 12.5 }
        }
      ]
    }
  }
}
```

Replace the two placeholders:

| Placeholder | Where to find it |
|---|---|
| `<your-project>.services.ai.azure.com/models` | Azure AI Foundry → your project → **Endpoint** |
| `<your-azure-foundry-api-key>` | Azure AI Foundry → your project → **Keys** |

> **Note:** `cost` values are in USD per million tokens and are optional — they are used by `/session` to show spend. Update them if Azure pricing differs from the values above.

If `models.json` already exists with other providers, add `azure-foundry-anthropic` as a new key inside the existing `"providers"` object.

### 4 — Install the extension

```bash
# Clone this repo
git clone https://github.com/AI4Belgium/pi-jev-router
cd pi-jev-router

# Copy the extension to your pi user extensions directory
cp extensions/jev-router.ts ~/.pi/agent/extensions/
```

Pi loads every `.ts` and `.js` file in `~/.pi/agent/extensions/` automatically on start-up.  
No `--extension` flag needed after the first copy.

### 5 — Start pi with the jev/auto model

```bash
pi --model jev/auto
```

Or save it as your default so every new session uses it:

```
/model          → search for "jev" → select jev/auto → press Ctrl+S
```

On the first message you should see a notification like:

```
🔵 jev → standard (claude-sonnet-4-6)
```

---

## Troubleshooting

**"Model azure-foundry-anthropic/claude-opus-5-5 is not in the catalog"**  
The `models.json` entry is missing or has a typo. Run `/model` in pi to reload the file and check that the four model IDs appear under `azure-foundry-anthropic`.

**No Jev notification appears**  
Check that `TYPESAFE_API_KEY` is exported in the shell where you run pi (`echo $TYPESAFE_API_KEY`). If the key is missing, `chooseTier` falls back silently to the previous tier and skips the notification.

**The router never escalates**  
The loop escalation fires only when there is real trouble (≥ 2 failed tool results in the last 6, or ≥ 3 edits to the same file) *and* Jev is confident (≥ 70 %). Lower `MIN_CONFIDENCE` or `ERROR_THRESHOLD` at the top of `jev-router.ts` to make it more aggressive.

**I want to use different model names or a non-Azure endpoint**  
Edit the `TIERS` constant and the `PROVIDER` constant at the top of `extensions/jev-router.ts`, and update your `models.json` provider entry to match.

---

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

Common adjustments:

- Raise `MIN_CONFIDENCE` to `0.85` to escalate only when Jev is very sure.
- Lower `CHECK_EVERY` to `3` to react faster to struggling.
- Set `ERROR_THRESHOLD` to `1` if a single failure should be enough to trigger a check.

---

## Notifications

Every routing decision fires a pi toast notification (interactive TUI only):

| Situation | Notification |
|---|---|
| New user message, classified | `🔵 jev → standard (claude-sonnet-4-6)` |
| In-loop escalation | `🟠 jev ↑ complex (claude-opus-5-5) — 6 failing tool results in the last 6` |

Notifications are suppressed in JSON and RPC modes (`ctx.hasUI` is false).

---

## Development

Type-check with the TypeScript compiler bundled inside pi:

```bash
PI=$(npm root -g)/@earendil-works/pi-coding-agent

mkdir -p /tmp/jevcheck && cd /tmp/jevcheck
mkdir -p node_modules/@earendil-works
ln -sf "$PI" node_modules/@earendil-works/pi-coding-agent
ln -sf "$PI/node_modules/@earendil-works/pi-ai" node_modules/@earendil-works/pi-ai
cp ~/.pi/agent/extensions/jev-router.ts .

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

"$PI/node_modules/.bin/tsc" -p .
```

---

## License

MIT

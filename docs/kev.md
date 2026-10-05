# Kev runtime

Odai's Node API can send typed decisions to a Kev server on the same machine. Kev loads and runs the model. Odai validates the answer types, option keys, probability distributions, input truncation, and optional checkpoint identity.

The client follows the Kev 1.0 `/v1/systemone` and `/v1/models` contracts.

## Start Kev

From a Kev checkout, install the serving dependencies and start champion C:

```sh
uv sync --extra serve
uv run --extra serve python -m kev.serve --run runs/kev-accuracy-75-20260928/calibration-C-lr2e6 --host 127.0.0.1 --port 8009
```

The checkpoint is a local run directory. Keep the server bound to loopback. Odai checks this run identity by default and rejects another checkpoint. Pass `expectedRun` to select a different run explicitly.

## Request typed decisions

```ts
import { createKevClient } from '@socketsecurity/odai/node'

const kev = createKevClient()
const result = await kev.decide({
  state: 'A package arrived late and the card shows two charges.',
  questions: {
    route: {
      type: 'choice',
      criteria: {
        billing: 'Payment issues',
        shipping: 'Delivery issues',
      },
    },
    urgent: { type: 'noul', instructions: 'Does this need urgent review?' },
    severity: { type: 'score', criteria: ['low', 'medium', 'high'] },
  },
})

console.log(result.answers.route)
```

Set `ODAI_KEV_URL` to change the local server URL. Set `KEV_API_KEY` when the server requires bearer authentication. Pass `expectedRun` to check the loaded checkpoint through Kev's `/v1/models` endpoint before each decision.

The client rejects remote URLs and truncated states. It does not download weights, launch training, or start the Kev server.

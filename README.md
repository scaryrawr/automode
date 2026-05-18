# Auto Mode

## Usage

Use `/auto on`, `/auto off`, and `/auto show` to control automatic permission handling.

Use `/automodel` to choose a classifier model interactively, `/automodel <model-id>` to set one directly, or `/automodel reset` to fall back to the normal Copilot default model.

When Copilot CLI is running with a custom provider (`COPILOT_PROVIDER_BASE_URL`), `/automodel` lists models from the provider's `/v1/models` endpoint. It also includes configured provider model IDs from `COPILOT_PROVIDER_MODEL_ID` and `COPILOT_MODEL`, and uses those environment values as the reset/default classifier model fallback.

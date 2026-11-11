# OpenCode Go with Pi and LiteLLM

If an omnigent OpenCode session cannot access its Go credentials, Pi can use
OpenCode Go through a local LiteLLM gateway. This requires Pi, omnigent and an
active Go subscription. The gateway uses the Go API key; it must run on the
omnigent host and stay running while sessions use it.

1. Install LiteLLM with the proxy extra, following the [LiteLLM installation
   guide](https://docs.litellm.ai/docs/proxy/quick_start). Configure the gateway
   with `OPENCODE_API_KEY` and a separate `LITELLM_MASTER_KEY` in its process
   environment. Keep both keys out of the configuration file and repository.
2. Use a gateway config such as the following. Add a `model_list` entry and an
   omnigent allowlist entry for each Go model you want to select. Keep the
   gateway bound to localhost and require the master key.

   ```yaml
   model_list:
     - model_name: opencode-go/deepseek-v4.1-flash
       litellm_params:
         model: opencode_go/deepseek-v4.1-flash
         api_key: os.environ/OPENCODE_API_KEY
   general_settings:
     master_key: os.environ/LITELLM_MASTER_KEY
   litellm_settings:
     drop_params: true
   ```

   Start it with `litellm --config <config.yaml> --host 127.0.0.1 --port 4009`.
   Arrange for the gateway to start on login if it should survive restarts. See
   [LiteLLM's Go provider documentation](https://docs.litellm.ai/docs/providers/opencode_go)
   for supported models and session requirements.
3. Pi must send a stable session ID so Go can route each conversation. Save the
   following as `~/.pi/agent/extensions/litellm-session.ts` on the omnigent host.
   Change the URL if the gateway listens elsewhere. The condition limits the
   header to this gateway.

   ```ts
   export default function (pi: any) {
     pi.on("before_provider_headers", (event: any, ctx: any) => {
       if (ctx.model?.baseUrl === "http://127.0.0.1:4009/v1") {
         event.headers["x-litellm-session-id"] = ctx.sessionManager.getSessionId();
       }
     });
   }
   ```

4. Merge the following into omnigent's `~/.omnigent/config.yaml`. Replace
   `<master-key-command>` with a command that reads the gateway master key from
   a private secret store or file. Preserve other providers and settings. A Pi
   inference binding selects one provider for the whole harness; back up an
   existing Pi binding before replacing it.

   ```yaml
   providers:
     go-gateway:
       kind: local
       default: pi
       openai:
         base_url: http://127.0.0.1:4009/v1
         auth_command: <master-key-command>
         wire_api: chat
         context_window: 65536
         max_output_tokens: 4096
         models:
           default: opencode-go/deepseek-v4.1-flash
   inference:
     harnesses:
       pi:
         provider: go-gateway
         default_model: opencode-go/deepseek-v4.1-flash
         model_allowlist: [opencode-go/deepseek-v4.1-flash]
       pi-native:
         provider: go-gateway
         default_model: opencode-go/deepseek-v4.1-flash
         model_allowlist: [opencode-go/deepseek-v4.1-flash]
   ```

5. In Corral, choose the `pi` harness and a configured Go model, then dispatch
   a small test. A custom omnigent agent must itself use `pi-native`; changing
   the harness on a task does not convert an OpenCode agent. If the catalog is
   stale, restart the omnigent host when it is safe to do so.

The gateway is a workaround, not a repair to OpenCode's credential bridge.
Ornith can be restored by reverting the saved Pi binding, or added to the same
LiteLLM gateway after testing its own endpoint and model routing.

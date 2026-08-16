# dsh-native-command

English | [中文](README.zh.md)

A **zero-dependency no-shell `execFile` runner** shared by host-native OS integrations: one `runNativeCommand(command, args, signal, options?)` call spawns the executable directly (never a shell string), captures utf8 stdout/stderr, propagates the caller's abort into child termination, and hides the transient console window on Windows. An optional `options.maxBuffer` raises the execFile output bound for callers that expect larger streams. Failures reject with the exit `code` and both captured streams attached, so callers classify (missing tool, cancelled, real failure) without re-running anything.

Its two consumers are the host-side native integrations: the [`directory-picker-native`](../../host/directory-picker-native/README.md) backend's OS chooser commands and the gateway's open-with-default-application hand-off ([`dsh-host-apiproxy`](../../host/apiproxy/README.md) `host.openPath`). The `NativeCommandRunner` type is their injectable command boundary.

It is a **library, not a service or plugin**: no `ctx`, registers nothing, holds no state, emits no events.

## Surface

```ts
import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
```

## Model Experience

None, as this is host-side subprocess plumbing; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Default output bounding** — both streams buffer unbounded in memory unless the caller passes `options.maxBuffer`; small native tools (a path or an error line) need no bound, while callers with meaningful output volume must set one explicitly (dsh-tool-orchestrator derives it from its schema caps).

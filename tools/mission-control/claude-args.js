// Argument shape for a backgrounded `claude` session.
//
// The prompt is the POSITIONAL argument. The CLI rejects `--bg -p` outright:
//
//   --bg and --print conflict: --print never starts the interactive session that
//   `claude agents` attaches to, so the job would be unattachable.
//
// Every dispatch path in this repo used `-p`, so each one exited non-zero without
// spawning anything. Three call sites had the same bug (webhook-server spawnAgent,
// webhook-server /reply, event-dispatcher spawn-agent), which is why the shape lives
// in one place now.

export function claudeBgArgs({ agent = null, prompt, model = null, resumeId = null } = {}) {
  if (!prompt) throw new Error('claudeBgArgs: prompt required');
  return [
    ...(resumeId ? ['--resume', String(resumeId)] : []),
    '--bg',
    ...(agent ? ['--agent', String(agent)] : []),
    ...(model ? ['--model', String(model)] : []),
    String(prompt),
  ];
}

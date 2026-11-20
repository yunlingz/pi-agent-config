# Maintain node-scripts

- Keep one workspace per Pi session and nine exposed tools.
- Keep runtime modules independent of Pi imports; the extension supplies Pi lifecycle and UI integration.
- Use ordinary script files, npm, and Node APIs. Do not add inline execution, snapshots, retention management, callbacks, or an exec framework.
- Keep job runs single-use and sequential at the tool level. Scripts own internal concurrency.
- Preserve background processes across compaction and reload. Interrupting timed work terminates and deprecates it.
- Quit and session replacement must terminate running jobs. Never kill persisted PIDs after restart.
- Keep definitions and full logs. Do not automatically delete or migrate old workspaces.
- Keep one shared recency comparator. Exact-status lists use it directly; the combined panel puts running jobs first.
- Keep node_job_list status and recentN required. Keep the collapsed panel within ten physical lines.
- Keep ESM and reuse guidance in standard tool registration. Do not inject a custom prompt section or prescribe authoring tools.
- Record entry SHA-256 before launch; compare current source only on query. Do not alter execution status or recency after source changes.
- Check managed paths within the session's canonical workspace before I/O. Preserve general project scope for mkdir/rm.
- Follow the installed todo plugin's visual conventions. Align columns by terminal width; keep metadata in expanded results.
- Follow the shared TypeScript rules. Verify actual process trees, Pi lifecycle, native tools, terminal UI, and live configured-model behavior.

import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  getMarkdownTheme,
  sessionEntryToContextMessages,
  type SessionEntry,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Spacer,
  type Component,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";

interface HistorySnapshot {
  selected: SessionEntry[];
  remaining: number;
  total: number;
}

class StatusLine implements Component {
  constructor(
    private readonly text: () => string,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    return [truncateToWidth(` ${this.theme.fg("muted", this.text())}`, width)];
  }

  invalidate(): void {}
}

function userText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (part?.type === "text") {
        return part.text ?? "";
      }
      if (part?.type === "image") {
        return `[image: ${part.mimeType ?? "unknown"}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export class HistoryTranscript implements Component {
  private readonly content = new Container();
  private expandables: Array<{ setExpanded(expanded: boolean): void }> = [];
  private snapshot: HistorySnapshot = { selected: [], remaining: 0, total: 0 };
  private expanded = false;

  constructor(
    private readonly ui: TUI,
    private readonly theme: Theme,
    private readonly cwd: string,
  ) {}

  update(snapshot: HistorySnapshot, expanded: boolean): void {
    this.snapshot = snapshot;
    this.expanded = expanded;
    this.rebuild();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) {
      return;
    }

    this.expanded = expanded;
    for (const component of this.expandables) {
      component.setExpanded(expanded);
    }
  }

  render(width: number): string[] {
    if (this.snapshot.selected.length === 0) {
      return [];
    }

    return this.content.render(width);
  }

  invalidate(): void {
    this.content.invalidate();
  }

  private rebuild(): void {
    this.content.clear();
    this.expandables = [];

    if (this.snapshot.selected.length === 0) {
      return;
    }

    this.content.addChild(new Spacer(1));
    this.content.addChild(new StatusLine(
      () => this.snapshot.remaining > 0
        ? `${this.snapshot.remaining} older saved entries load automatically near the top.`
        : "Beginning of saved session history.",
      this.theme,
    ));
    this.content.addChild(new Spacer(1));

    const pendingTools = new Map<string, ToolExecutionComponent>();
    for (const entry of this.snapshot.selected) {
      for (const message of sessionEntryToContextMessages(entry)) {
        this.addStoredMessage(message, pendingTools);
      }
    }

    this.content.addChild(new Spacer(1));
    this.content.addChild(new StatusLine(
      () => `Restored compacted history: ${this.snapshot.selected.length} of ${this.snapshot.total} saved entries shown.`,
      this.theme,
    ));
    this.content.addChild(new Spacer(1));
  }

  private addStoredMessage(
    message: ReturnType<typeof sessionEntryToContextMessages>[number],
    pendingTools: Map<string, ToolExecutionComponent>,
  ): void {
    const markdownTheme = getMarkdownTheme();

    switch (message.role) {
      case "system":
        return;
      case "user": {
        const text = userText(message.content);
        if (!text) {
          return;
        }
        if (this.content.children.length > 0) {
          this.content.addChild(new Spacer(1));
        }
        this.content.addChild(new UserMessageComponent(text, markdownTheme, 1));
        return;
      }
      case "assistant": {
        this.content.addChild(new AssistantMessageComponent(
          message,
          true,
          markdownTheme,
          "Thinking",
          1,
        ));
        for (const part of message.content) {
          if (part.type !== "toolCall") {
            continue;
          }

          const tool = new ToolExecutionComponent(
            part.name,
            part.id,
            part.arguments,
            { showImages: false, outputPad: 1 },
            undefined,
            this.ui,
            this.cwd,
          );
          tool.setExpanded(this.expanded);
          this.expandables.push(tool);
          this.content.addChild(tool);
          pendingTools.set(part.id, tool);
        }
        return;
      }
      case "toolResult": {
        const tool = pendingTools.get(message.toolCallId);
        if (!tool) {
          return;
        }
        tool.updateResult(message);
        pendingTools.delete(message.toolCallId);
        return;
      }
      case "bashExecution": {
        const bash = new BashExecutionComponent(
          message.command,
          this.ui,
          message.excludeFromContext,
          1,
        );
        if (message.output) {
          bash.appendOutput(message.output);
        }
        bash.setComplete(
          message.exitCode,
          message.cancelled,
          message.truncated ? { truncated: true } : undefined,
          message.fullOutputPath,
        );
        bash.setExpanded(this.expanded);
        this.expandables.push(bash);
        this.content.addChild(bash);
        return;
      }
      case "custom": {
        if (!message.display) {
          return;
        }
        const custom = new CustomMessageComponent(message, undefined, markdownTheme, 1);
        custom.setExpanded(this.expanded);
        this.expandables.push(custom);
        this.content.addChild(custom);
        return;
      }
      case "compactionSummary": {
        const summary = new CompactionSummaryMessageComponent(message, markdownTheme, 1);
        summary.setExpanded(this.expanded);
        this.expandables.push(summary);
        this.content.addChild(new Spacer(1));
        this.content.addChild(summary);
        return;
      }
      case "branchSummary": {
        const summary = new BranchSummaryMessageComponent(message, markdownTheme, 1);
        summary.setExpanded(this.expanded);
        this.expandables.push(summary);
        this.content.addChild(new Spacer(1));
        this.content.addChild(summary);
        return;
      }
    }
  }
}

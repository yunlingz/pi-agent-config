import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  DEFAULT_PRELOAD_SCREENS,
  HistoryWindow,
  collectHiddenEntries,
} from "./history-window.ts";
import { HistoryTranscript } from "./history-transcript.ts";

const WIDGET_KEY = "session-history-mount";
const RUNTIME_STATE_KEY = Symbol.for("pi.session-history.runtime-state.v1");
const MAX_SAVED_SESSIONS = 10;

interface SavedViewState {
  earliestEntryId?: string;
  viewportTop: number;
  followingOutput: boolean;
}

interface RuntimeState {
  sessions: Map<string, SavedViewState>;
}

interface DocumentContainer extends Component {
  children: Component[];
}

interface FullscreenTui extends TUI {
  readonly viewportTop: number;
  readonly isFollowingOutput: boolean;
  scrollBy(lines: number): void;
  scrollToTop(): void;
  scrollToBottom(): void;
}

// Installed Pi uses the fullscreen tag for its scrolling TUI implementation.
function isFullscreenTui(tui: TUI): tui is FullscreenTui {
  return tui.mode === "fullscreen";
}

function runtimeState(): RuntimeState {
  // The symbol shares this extension's typed state across Pi reloads.
  const scope = globalThis as typeof globalThis & {
    [RUNTIME_STATE_KEY]?: RuntimeState;
  };
  scope[RUNTIME_STATE_KEY] ??= { sessions: new Map() };
  return scope[RUNTIME_STATE_KEY];
}

function rememberState(sessionId: string, state: SavedViewState): void {
  const sessions = runtimeState().sessions;
  sessions.delete(sessionId);
  sessions.set(sessionId, state);

  while (sessions.size > MAX_SAVED_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    sessions.delete(oldest);
  }
}

function isDocumentContainer(component: Component | undefined): component is DocumentContainer {
  return !!component && "children" in component && Array.isArray(component.children);
}

class EmptyMount implements Component {
  private readonly disposeMount: () => void;

  constructor(disposeMount: () => void) {
    this.disposeMount = disposeMount;
  }

  render(): string[] {
    return [];
  }

  invalidate(): void {}

  dispose(): void {
    this.disposeMount();
  }
}

class SessionHistoryController {
  private readonly historyWindow = new HistoryWindow<SessionEntry>();
  private transcript?: HistoryTranscript;
  private document?: DocumentContainer;
  private tui?: TUI;
  private inputTimer?: ReturnType<typeof setTimeout>;
  private restoreTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private warnedUnsupportedLayout = false;

  private readonly ctx: ExtensionContext;
  private readonly sessionManager: ExtensionContext["sessionManager"];

  constructor(ctx: ExtensionContext, sessionManager: ExtensionContext["sessionManager"]) {
    this.ctx = ctx;
    this.sessionManager = sessionManager;
  }

  mount(tui: TUI, theme: Theme): void {
    this.unmount();
    this.disposed = false;
    this.tui = tui;

    const document = tui.children[0];
    if (!isDocumentContainer(document) || document.children.length === 0) {
      this.warnUnsupportedLayout();
      return;
    }

    const state = runtimeState().sessions.get(this.sessionManager.getSessionId());
    const transcript = new HistoryTranscript(
      tui,
      theme,
      this.sessionManager.getCwd(),
    );
    transcript.update(
      this.historyWindow.refresh(
        collectHiddenEntries(this.sessionManager),
        state?.earliestEntryId,
      ),
      this.ctx.ui.getToolsExpanded(),
    );

    const chatIndex = document.children.length - 1;
    document.children.splice(chatIndex, 0, transcript);
    this.document = document;
    this.transcript = transcript;
    this.scheduleRestore(state);
  }

  noteInput(data: string): void {
    if (this.disposed || !this.tui || this.tui.hasOverlay()) {
      return;
    }

    const jumpToStart = this.tui.mode === "fullscreen"
      && getKeybindings().matches(data, "tui.altScreen.top");
    if (this.inputTimer) {
      clearTimeout(this.inputTimer);
    }
    this.inputTimer = setTimeout(() => {
      this.inputTimer = undefined;
      if (this.disposed || !this.transcript || !this.tui || this.tui.hasOverlay()) {
        return;
      }

      this.transcript.setExpanded(this.ctx.ui.getToolsExpanded());
      if (jumpToStart) {
        this.loadAllAndJumpToStart();
      } else {
        this.loadNearTop();
      }
    }, 0);
  }

  scheduleRefresh(): void {
    setTimeout(() => this.refresh(), 0);
  }

  saveState(): void {
    if (!this.tui) {
      return;
    }

    const snapshot = this.historyWindow.snapshot();
    rememberState(this.sessionManager.getSessionId(), {
      earliestEntryId: snapshot.earliestEntryId,
      viewportTop: isFullscreenTui(this.tui) ? this.tui.viewportTop : 0,
      followingOutput: !isFullscreenTui(this.tui) || this.tui.isFollowingOutput,
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.saveState();
    this.disposed = true;
    if (this.inputTimer) {
      clearTimeout(this.inputTimer);
      this.inputTimer = undefined;
    }
    if (this.restoreTimer) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = undefined;
    }
    this.unmount();
  }

  private refresh(): void {
    if (this.disposed || !this.transcript || !this.tui || !this.document) {
      return;
    }

    const width = this.tui.terminal.columns;
    const oldHeight = this.transcript.render(width).length;
    const prefixHeight = this.prefixHeight(width);
    const fullscreen = isFullscreenTui(this.tui) ? this.tui : undefined;
    const oldTop = fullscreen?.viewportTop ?? 0;
    const wasFollowing = fullscreen?.isFollowingOutput ?? true;
    const earliestEntryId = this.historyWindow.snapshot().earliestEntryId;

    this.transcript.update(
      this.historyWindow.refresh(
        collectHiddenEntries(this.sessionManager),
        earliestEntryId,
      ),
      this.ctx.ui.getToolsExpanded(),
    );
    const newHeight = this.transcript.render(width).length;
    this.tui.renderNow();

    if (!fullscreen) {
      return;
    }
    if (wasFollowing) {
      fullscreen.scrollToBottom();
    } else if (oldTop >= prefixHeight + oldHeight) {
      fullscreen.scrollBy(newHeight - oldHeight);
    }
    this.tui.requestRender();
  }

  private loadNearTop(): void {
    if (
      !this.tui
      || !isFullscreenTui(this.tui)
      || !this.transcript
      || !this.historyWindow.hasMore
    ) {
      return;
    }

    const fullscreen = this.tui;
    if (fullscreen.isFollowingOutput) {
      return;
    }

    const width = this.tui.terminal.columns;
    const preloadLines = this.tui.terminal.rows * DEFAULT_PRELOAD_SCREENS;
    if (fullscreen.viewportTop > this.prefixHeight(width) + preloadLines) {
      return;
    }

    this.expandWindow(() => this.historyWindow.loadMore(), true);
  }

  private loadAllAndJumpToStart(): void {
    if (!this.tui || !isFullscreenTui(this.tui) || !this.historyWindow.hasMore) {
      return;
    }

    this.expandWindow(() => this.historyWindow.loadAll(), false);
    this.tui.scrollToTop();
    this.tui.requestRender();
  }

  private expandWindow(
    update: () => ReturnType<HistoryWindow<SessionEntry>["snapshot"]>,
    preserveAnchor: boolean,
  ): void {
    if (!this.tui || !this.transcript) {
      return;
    }

    const width = this.tui.terminal.columns;
    const oldHeight = this.transcript.render(width).length;
    this.transcript.update(update(), this.ctx.ui.getToolsExpanded());
    const newHeight = this.transcript.render(width).length;
    this.tui.renderNow();

    if (preserveAnchor && isFullscreenTui(this.tui)) {
      this.tui.scrollBy(newHeight - oldHeight);
    }
    this.tui.requestRender();
  }

  private prefixHeight(width: number): number {
    if (!this.document || !this.transcript) {
      return 0;
    }

    const historyIndex = this.document.children.indexOf(this.transcript);
    if (historyIndex < 0) {
      return 0;
    }

    return this.document.children
      .slice(0, historyIndex)
      .reduce((height, component) => height + component.render(width).length, 0);
  }

  private scheduleRestore(state: SavedViewState | undefined): void {
    if (!state || !this.tui || this.tui.mode !== "fullscreen") {
      return;
    }

    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = undefined;
      if (this.disposed || !this.tui || !isFullscreenTui(this.tui)) {
        return;
      }

      const fullscreen = this.tui;
      this.tui.renderNow();
      if (state.followingOutput) {
        fullscreen.scrollToBottom();
      } else {
        fullscreen.scrollToTop();
        fullscreen.scrollBy(state.viewportTop);
      }
      this.tui.requestRender();
    }, 0);
  }

  private unmount(): void {
    if (this.document && this.transcript) {
      const index = this.document.children.indexOf(this.transcript);
      if (index >= 0) {
        this.document.children.splice(index, 1);
      }
    }
    this.document = undefined;
    this.transcript = undefined;
    this.tui?.requestRender();
    this.tui = undefined;
  }

  private warnUnsupportedLayout(): void {
    if (this.warnedUnsupportedLayout) {
      return;
    }
    this.warnedUnsupportedLayout = true;
    this.ctx.ui.notify(
      "Saved session history could not attach to this Pi terminal layout.",
      "warning",
    );
  }
}

export default function sessionHistoryExtension(pi: ExtensionAPI): void {
  let controller: SessionHistoryController | undefined;
  let unsubscribeInput: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    unsubscribeInput?.();
    controller?.dispose();
    controller = undefined;

    if (ctx.mode !== "tui") {
      return;
    }

    controller = new SessionHistoryController(ctx, ctx.sessionManager);
    const activeController = controller;
    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        activeController.mount(tui, theme);
        return new EmptyMount(() => activeController.dispose());
      },
      { placement: "aboveEditor" },
    );
    unsubscribeInput = ctx.ui.onTerminalInput((data) => {
      activeController.noteInput(data);
      return undefined;
    });
  });

  pi.on("session_compact", () => controller?.scheduleRefresh());
  pi.on("session_tree", () => controller?.scheduleRefresh());

  pi.on("session_shutdown", (_event, ctx) => {
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    controller?.dispose();
    controller = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  });
}

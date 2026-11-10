import type { AgentSession, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Terminal, TUI } from "@earendil-works/pi-tui";

// These contracts cover only the installed Powerline API used by the integration checks.
export interface FooterItem { id: string }
export interface FooterPreset {
  colors?: unknown;
  leftSegments: string[];
  rightSegments: string[];
  secondarySegments: string[];
}
export interface FooterConfig {
  preset: string;
  customItems: FooterItem[];
  invalidLayoutSegments: string[];
  invalidDisabledSegments: string[];
  disabledSegments: string[];
}
export interface FooterConfigModule {
  parsePowerlineConfig(value: unknown, presets: string[]): FooterConfig;
  mergeSegmentsWithCustomItems(preset: FooterPreset, items: FooterItem[], config: FooterConfig): {
    leftSegments: string[]; rightSegments: string[]; secondarySegments: string[];
  };
  collectHiddenExtensionStatusKeys(items: FooterItem[]): Set<string>;
}
export interface FooterPresetsModule {
  PRESETS: Record<string, FooterPreset>;
  getPreset(name: string): FooterPreset;
}
export interface FooterSegmentsModule {
  renderSegment(id: "custom:web_search" | "custom:cache_rate" | "extension_statuses", context: {
    theme: Theme;
    colors: unknown;
    customItemsById: Map<string, FooterItem>;
    extensionStatuses: Map<string, string>;
    hiddenExtensionStatusKeys: Set<string>;
  }): { visible: boolean; content: string };
}

export type TestWidget = Component & { dispose?(): void };
export type WidgetContent = string[] | ((tui: TUI, theme: Theme) => TestWidget) | undefined;

function unavailable(): never {
  throw new Error("This UI operation is outside the integration fixture.");
}

export interface TestTUI extends TUI {
  viewportTop: number;
  isFollowingOutput: boolean;
  scrollBy(lines: number): void;
  scrollToTop(): void;
  scrollToBottom(): void;
}

export function testTUI(document: Component, onRender: (lines: string[]) => void = () => {}): TestTUI {
  const terminal: Terminal = {
    columns: 140,
    rows: 45,
    kittyProtocolActive: false,
    start: unavailable,
    stop: unavailable,
    drainInput: unavailable,
    write: unavailable,
    moveBy: unavailable,
    hideCursor: unavailable,
    showCursor: unavailable,
    clearLine: unavailable,
    clearFromCursor: unavailable,
    clearScreen: unavailable,
    setTitle() {},
    setProgress: unavailable,
    setProgramStatus: unavailable,
  };
  let renderedLines: string[] = [];
  return {
    mode: "fullscreen",
    children: [document],
    terminal,
    fullRedraws: 0,
    viewportTop: 10_000,
    isFollowingOutput: true,
    addChild: unavailable,
    removeChild: unavailable,
    clear: unavailable,
    getShowHardwareCursor: unavailable,
    setShowHardwareCursor: unavailable,
    getClearOnShrink: unavailable,
    setClearOnShrink: unavailable,
    setFocus: unavailable,
    showOverlay: unavailable,
    hideOverlay: unavailable,
    hasOverlay: () => false,
    start: unavailable,
    stop: unavailable,
    addInputListener: unavailable,
    removeInputListener: unavailable,
    onTerminalColorSchemeChange: unavailable,
    setTerminalColorSchemeNotifications: unavailable,
    queryTerminalColors: unavailable,
    render: (width: number) => document.render(width),
    invalidate: () => document.invalidate(),
    requestRender() {},
    renderNow() {
      renderedLines = document.render(terminal.columns);
      onRender(renderedLines);
    },
    scrollBy(lines: number) {
      this.viewportTop = Math.max(0, this.viewportTop + lines);
      this.isFollowingOutput = false;
    },
    scrollToTop() {
      this.viewportTop = 0;
      this.isFollowingOutput = false;
    },
    scrollToBottom() {
      this.viewportTop = Math.max(0, renderedLines.length - terminal.rows);
      this.isFollowingOutput = true;
    },
  } satisfies TestTUI;
}

export function testUI(session: AgentSession, overrides: Partial<ExtensionUIContext>): ExtensionUIContext {
  const runner = session.extensionRunner;
  if (!runner) throw new Error("The integration session has no extension runner.");
  return { ...runner.getUIContext(), ...overrides };
}

# ci_dark for Pi

`ci_dark.json` is a portable Pi theme derived from [yunlingz/ci_dark's iTerm palette](https://github.com/yunlingz/ci_dark/blob/master/term/ci_dark.itermcolors). Original palette colors are retained in `vars`, with the accents used directly. UI neutrals are lightly desaturated so Pi's 256-color conversion keeps charcoal panels and gray text neutral instead of introducing teal casts.

| Source color | RGB |
|---|---|
| Background | `#24292e` |
| Foreground | `#f6f8fa` |
| Panels / cursor guide | `#2f363d` |
| Selection | `#545f6b` |
| Muted gray | `#959da5` |
| Green / primary accent | `#85e89d` |
| Blue / links and headings | `#79b8ff` |
| Violet / keywords | `#b392f0` |
| Cyan / types and inline code | `#73e3ff` |
| Yellow / warnings and numbers | `#ffea7f` |
| Red / errors and removed lines | `#f97583` |

The UI selection shade is intentionally darker than the source's terminal selection color so dim tree labels and selection accents remain readable. Secondary text is also checked on running-tool panels, and minimal-thinking indicators use the same neutral metadata palette.

## Use on Windows, Linux, or macOS

Copy `ci_dark.json` into the active agent directory's `themes` folder:

- Windows: `%USERPROFILE%\.pi\agent\themes\ci_dark.json`
- Linux and macOS: `~/.pi/agent/themes/ci_dark.json`
- If `PI_CODING_AGENT_DIR` is set, use its `themes` folder instead.

Select `ci_dark` in `/settings`, or set `"theme": "ci_dark"` in that agent directory's `settings.json`. Run `/reload` after manually changing settings. A fresh Pi session also uses the saved selection. The theme file itself hot-reloads while selected.

The theme has no OS-specific paths, extensions, fonts, or icon requirements. Pi uses exact RGB colors in truecolor terminals and approximates them in 256-color terminals. Leave capability detection automatic; force truecolor only if the entire terminal path supports it. A dark terminal background is recommended.

Pi themes do not set the terminal application's base canvas, cursor, or native scrollback colors. For an exact background match, set the terminal profile's background to `#24292e` separately. This configuration does not change terminal profiles or fonts.

## Tool cards

Pi's native state changes are preserved: neutral while running, muted dark green (`#1b241f`) after success, and dark red (`#301e24`) after failure. Finished cards are only slightly darker than the recommended canvas. Indexed 256-color approximations remain distinct, though the subtle green becomes a darker neutral shade.

## Existing Powerline footer

`../extensions/powerline-footer/theme.json` replaces the footer's fixed model/path colors and rainbow thinking text with Pi semantic color names. It therefore follows `ci_dark` and future theme selections in both color modes. This does not alter the footer preset, segment layout, icons, or cache-rate display. The override is optional on machines without `pi-powerline-footer`.

## Validation

From this repository, run:

```text
node themes/verify.mjs <installed-pi-package-directory>
```

This checks the installed schema and native loader, all 56 color roles in truecolor and 256-color modes, text contrast on representative backgrounds, card/canvas separation, native tool-state transitions, neutral fallback shades, and semantic footer colors. It uses only the installed Pi's dependencies; it makes no model or network requests.

For full interactive regression checks, compare Pi's original `system` theme with `ci_dark` under identical terminal colors and dimensions. Use a temporary workspace and a mock provider, but exercise the real `InteractiveMode` and tools rather than only rendering individual cards. Pi's SDK supports an injected `Terminal` for this purpose.

Cover streaming chat/thinking, write/read/edit, shell output and failures, queued follow-ups, structured-question previews, task status, Markdown/diffs, settings/model/tree selectors, transcript search, all thinking levels, compaction, normal quit, and a narrower viewport. Inspect the captured screen colors as well as lifecycle parity; selected tree metadata and secondary text on running cards need separate contrast checks.

Native terminal behavior should still be checked on each target OS. An emulated-terminal run on Windows does not establish native Linux/macOS, font, image-protocol, or every extension integration coverage.

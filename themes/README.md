# ci_dark for Pi

[ci_dark.json](ci_dark.json) uses the original [iTerm palette](https://github.com/yunlingz/ci_dark/blob/master/term/ci_dark.itermcolors).
Its background is `#24292e`, foreground `#f6f8fa`, and accents use the source RGB values.
Derived dark panels and neutral metadata preserve readable contrast in truecolor and 256-color modes.

Select `ci_dark` in `/settings` or set `"theme": "ci_dark"` in the active agent directory's settings.
Pi hot-reloads the selected theme file. Use `/reload` after changing extension code or footer overrides.

## Complete terminal surfaces

The local `extensions/ci-dark` adapter supplies explicit default foreground and background colors for Pi's TUI output.
It fills unstyled editor text, blank regions, and reset-colored text without changing the terminal profile or ANSI palette.
It also maps Powerline's fixed gray prompt and separator colors to theme roles.
Explicit syntax colors, tool panels, hyperlinks, cursor controls, and image payloads remain intact.
The adapter is inactive for other themes and restores the original output transport on shutdown or reload.

[The Powerline override](../extensions/powerline-footer/theme.json) replaces fixed model/path colors and high-effort rainbow text with semantic colors.
No installed package files are modified. Native editor and extension features remain available.

Pi's application theme does not control Windows Terminal tabs/settings, terminal selection, hardware cursor color, or browser review pages.
Those interfaces have separate owners. Existing terminal profiles and fonts remain unchanged.
Truecolor shows exact RGB values; 256-color terminals use Pi's supported approximations.

## Verification

Run from the agent directory:

```text
node themes/verify.ts <installed-pi-package-directory>
```

The check covers all semantic roles, contrast, native tool states, and footer colors in both color modes.
It also runs actual Pi chat/editor/Powerline rendering against black and white terminal defaults in regular and fullscreen modes.
Terminal-emulator assertions check explicit backgrounds, editor colors, resize, settings, and shutdown.
The offline extension workflow includes regressions for resets, RGB channels, split writes, links, images, and transport restoration.
These checks use installed dependencies without model requests; native Windows/macOS terminal coverage remains separate.

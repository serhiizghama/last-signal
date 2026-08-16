# tools/assets

Slices the accepted raw art sheets in `art/raw/` into individual game sprites plus a
manifest, and writes them into `apps/web/public/assets/`.

## Run

```sh
pnpm --filter @last-signal/tools-assets run slice
```

Safe to re-run from scratch: it clears `apps/web/public/assets/` first, then regenerates
every sprite and `manifest.json` from the current contents of `art/raw/`.

## How it works

Two extraction strategies, chosen per sheet/region in `src/sheets.ts`:

- **grid** — sheet divided into an exact rows×cols grid. Used only where sprites are known
  to tile edge-to-edge with no transparent gap (`terrain_tiles.png`), where connected-component
  detection would incorrectly merge neighboring cells into one blob.
- **bbox** — sprite boxes found via alpha-channel connected-component detection
  (`src/geometry.ts`), then sorted into reading order (top-to-bottom band, then
  left-to-right). Used for everything else. Self-corrects exact sprite bounds instead of
  trusting assumed cell math, so it's more robust if a sheet gets regenerated with slightly
  different framing.

For the two heavily mixed/irregular sheets (`ui_buttons.png`, `ui_panels.png`), each visually
distinct sub-area (e.g. the large-button grid vs. the icon-button grid vs. the round toggles)
is carved out first as a fractional region of the sheet, then sliced with grid or bbox
within that region.

**Touching-sprite recovery.** Occasionally a prop physically touches or overlaps a
neighboring sprite in the generated art (e.g. a thrown weapon bridging two raider
figures, or debris spanning the gap between two building rows), so connected-component
detection returns fewer boxes than expected. When that happens, the slicer repeatedly
splits the largest detected box at whichever seam — a vertical column or a horizontal row,
whichever has the lower opaque-pixel density — best separates it, until the count matches.
If it still doesn't match, the script throws with the sheet name and the boxes it found,
rather than guessing a slice.

All sheets have alpha channels that cap at 254 (not 255) and carry low-but-nonzero alpha
noise across nominally transparent regions — harmless for compositing, but bbox/trim logic
thresholds at `alpha > 10`, not `== 255`.

## Sizing decisions

See the "## Slicing" section at the bottom of `docs/ASSET_PROMPTS.md` for the full
first-pass sizing table and rationale.

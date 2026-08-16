/**
 * Per-sheet slicing configuration.
 *
 * Two extraction strategies (per the session brief):
 *  - "grid": sheet dimensions are divided into an exact rows x cols grid (used only where
 *    sprites are known to touch/tile edge-to-edge, e.g. terrain_tiles, so bbox detection
 *    would incorrectly merge neighboring cells).
 *  - "bbox": sprite boxes are found via alpha-channel connected-component detection and
 *    sorted into reading order (top-to-bottom band, then left-to-right). This is used for
 *    everything else, including nominally-"grid" sheets, because it self-corrects exact
 *    sprite bounds instead of trusting assumed cell math — robust to sheets being
 *    regenerated with slightly different framing.
 *
 * Sizes are first-pass drafts (see docs/ASSET_PROMPTS.md "## Slicing" for the writeup),
 * anchored on the one pinned number we have: 32px base map tile
 * (docs/M2_DESIGN_DECISIONS.md §11).
 */

export interface ItemSpec {
  /** Stable manifest id, e.g. "unit.raiders.brute". */
  id: string;
  /** Output path, relative to apps/web/public/assets/. */
  file: string;
  /** Fit-inside box [width, height] in px — aspect ratio is preserved, nearest-neighbor resize. */
  target: [number, number];
}

export interface FracRegion {
  xFrac: [number, number];
  yFrac: [number, number];
}

export type SliceGroup =
  | { kind: 'grid'; region?: FracRegion; rows: number; cols: number; items: ItemSpec[] }
  | { kind: 'bbox'; region?: FracRegion; mergeGap: number; items: ItemSpec[] }
  | { kind: 'single'; region?: FracRegion; trim: boolean; item: ItemSpec };

export interface SheetConfig {
  file: string;
  groups: SliceGroup[];
}

const TILE = 32;

export const sheets: SheetConfig[] = [
  // Uniform grid, opaque, tiles touch edge-to-edge -> must use fixed grid math, not bbox.
  {
    file: 'terrain_tiles.png',
    groups: [
      {
        kind: 'grid',
        rows: 3,
        cols: 3,
        items: [
          {
            id: 'map.tile.wasteland_dirt_1',
            file: 'map/tiles/wasteland_dirt_1.png',
            target: [TILE, TILE],
          },
          {
            id: 'map.tile.wasteland_dirt_2',
            file: 'map/tiles/wasteland_dirt_2.png',
            target: [TILE, TILE],
          },
          {
            id: 'map.tile.wasteland_dirt_3',
            file: 'map/tiles/wasteland_dirt_3.png',
            target: [TILE, TILE],
          },
          { id: 'map.tile.ruined_city', file: 'map/tiles/ruined_city.png', target: [TILE, TILE] },
          { id: 'map.tile.dead_forest', file: 'map/tiles/dead_forest.png', target: [TILE, TILE] },
          {
            id: 'map.tile.irradiated_lake',
            file: 'map/tiles/irradiated_lake.png',
            target: [TILE, TILE],
          },
          {
            id: 'map.tile.cracked_highway',
            file: 'map/tiles/cracked_highway.png',
            target: [TILE, TILE],
          },
          {
            id: 'map.tile.farm_windmill',
            file: 'map/tiles/farm_windmill.png',
            target: [TILE, TILE],
          },
          { id: 'map.tile.rocky_hills', file: 'map/tiles/rocky_hills.png', target: [TILE, TILE] },
        ],
      },
    ],
  },

  {
    file: 'icons_resources_markers.png',
    groups: [
      {
        kind: 'grid',
        rows: 2,
        cols: 4,
        items: [
          { id: 'map.icon.resource.scrap', file: 'map/icons/scrap.png', target: [TILE, TILE] },
          { id: 'map.icon.resource.fuel', file: 'map/icons/fuel.png', target: [TILE, TILE] },
          { id: 'map.icon.resource.circuit', file: 'map/icons/circuit.png', target: [TILE, TILE] },
          { id: 'map.icon.resource.food', file: 'map/icons/food.png', target: [TILE, TILE] },
          {
            id: 'map.marker.village.red_skull',
            file: 'map/markers/red_skull.png',
            target: [40, 40],
          },
          {
            id: 'map.marker.village.blue_gear',
            file: 'map/markers/blue_gear.png',
            target: [40, 40],
          },
          {
            id: 'map.marker.village.green_bull',
            file: 'map/markers/green_bull.png',
            target: [40, 40],
          },
          {
            id: 'map.marker.village.neutral_ruined',
            file: 'map/markers/neutral_ruined.png',
            target: [40, 40],
          },
        ],
      },
    ],
  },

  {
    file: 'source_antenna.png',
    groups: [
      {
        kind: 'single',
        trim: true,
        item: { id: 'map.object.signal_source', file: 'map/signal_source.png', target: [128, 128] },
      },
    ],
  },

  {
    file: 'units_raiders.png',
    groups: [
      {
        kind: 'bbox',
        mergeGap: 24,
        items: [
          { id: 'unit.raiders.brute', file: 'units/raiders/brute.png', target: [96, 64] },
          {
            id: 'unit.raiders.molotov_thrower',
            file: 'units/raiders/molotov_thrower.png',
            target: [96, 64],
          },
          { id: 'unit.raiders.biker', file: 'units/raiders/biker.png', target: [96, 64] },
          { id: 'unit.raiders.scout', file: 'units/raiders/scout.png', target: [96, 64] },
          {
            id: 'unit.raiders.siege_truck',
            file: 'units/raiders/siege_truck.png',
            target: [96, 64],
          },
        ],
      },
    ],
  },

  {
    file: 'units_engineers.png',
    groups: [
      {
        kind: 'bbox',
        mergeGap: 24,
        items: [
          {
            id: 'unit.engineers.exo_trooper',
            file: 'units/engineers/exo_trooper.png',
            target: [96, 64],
          },
          {
            id: 'unit.engineers.bulwark_guard',
            file: 'units/engineers/bulwark_guard.png',
            target: [96, 64],
          },
          {
            id: 'unit.engineers.quad_bike',
            file: 'units/engineers/quad_bike.png',
            target: [96, 64],
          },
          {
            id: 'unit.engineers.hover_drone',
            file: 'units/engineers/hover_drone.png',
            target: [96, 64],
          },
          {
            id: 'unit.engineers.crane_rig',
            file: 'units/engineers/crane_rig.png',
            target: [96, 64],
          },
        ],
      },
    ],
  },

  {
    file: 'units_nomads.png',
    groups: [
      {
        kind: 'bbox',
        mergeGap: 24,
        items: [
          { id: 'unit.nomads.skirmisher', file: 'units/nomads/skirmisher.png', target: [96, 64] },
          { id: 'unit.nomads.sniper', file: 'units/nomads/sniper.png', target: [96, 64] },
          { id: 'unit.nomads.dune_buggy', file: 'units/nomads/dune_buggy.png', target: [96, 64] },
          { id: 'unit.nomads.falconer', file: 'units/nomads/falconer.png', target: [96, 64] },
          {
            id: 'unit.nomads.ballista_wagon',
            file: 'units/nomads/ballista_wagon.png',
            target: [96, 64],
          },
        ],
      },
    ],
  },

  {
    file: 'buildings_1.png',
    groups: [
      {
        kind: 'bbox',
        mergeGap: 12,
        items: [
          { id: 'building.command_center', file: 'buildings/command_center.png', target: [96, 96] },
          { id: 'building.scrap_yard', file: 'buildings/scrap_yard.png', target: [96, 96] },
          { id: 'building.refinery', file: 'buildings/refinery.png', target: [96, 96] },
          { id: 'building.workshop', file: 'buildings/workshop.png', target: [96, 96] },
          { id: 'building.greenhouse', file: 'buildings/greenhouse.png', target: [96, 96] },
          { id: 'building.warehouse', file: 'buildings/warehouse.png', target: [96, 96] },
        ],
      },
    ],
  },

  {
    file: 'buildings_2.png',
    groups: [
      {
        kind: 'bbox',
        mergeGap: 12,
        items: [
          { id: 'building.cold_storage', file: 'buildings/cold_storage.png', target: [96, 96] },
          { id: 'building.barracks', file: 'buildings/barracks.png', target: [96, 96] },
          { id: 'building.machine_shop', file: 'buildings/machine_shop.png', target: [96, 96] },
          // Irregular footprint (wall + watchtower, wider than the other 5 compact buildings).
          { id: 'building.wall', file: 'buildings/wall.png', target: [192, 64] },
          { id: 'building.market', file: 'buildings/market.png', target: [96, 96] },
          { id: 'building.radio_tower', file: 'buildings/radio_tower.png', target: [96, 96] },
        ],
      },
    ],
  },

  // Mixed grid: large buttons + icon buttons + round toggles + progress bar elements.
  // Sub-regions were located by visual inspection of the sheet (see ASSET_PROMPTS.md notes).
  {
    file: 'ui_buttons.png',
    groups: [
      {
        kind: 'grid',
        region: { xFrac: [0, 0.75], yFrac: [0, 0.6] },
        rows: 3,
        cols: 2,
        items: [
          {
            id: 'ui.button.primary.normal',
            file: 'ui/buttons/primary_normal.png',
            target: [168, 56],
          },
          {
            id: 'ui.button.primary.pressed',
            file: 'ui/buttons/primary_pressed.png',
            target: [168, 56],
          },
          {
            id: 'ui.button.secondary.normal',
            file: 'ui/buttons/secondary_normal.png',
            target: [168, 56],
          },
          {
            id: 'ui.button.secondary.pressed',
            file: 'ui/buttons/secondary_pressed.png',
            target: [168, 56],
          },
          {
            id: 'ui.button.danger.normal',
            file: 'ui/buttons/danger_normal.png',
            target: [168, 56],
          },
          {
            id: 'ui.button.danger.pressed',
            file: 'ui/buttons/danger_pressed.png',
            target: [168, 56],
          },
        ],
      },
      {
        kind: 'grid',
        region: { xFrac: [0.75, 1.0], yFrac: [0, 0.6] },
        rows: 3,
        cols: 2,
        items: [
          {
            id: 'ui.button.icon.close.normal',
            file: 'ui/buttons/icon_close_normal.png',
            target: [40, 40],
          },
          {
            id: 'ui.button.icon.close.pressed',
            file: 'ui/buttons/icon_close_pressed.png',
            target: [40, 40],
          },
          {
            id: 'ui.button.icon.gear.normal',
            file: 'ui/buttons/icon_gear_normal.png',
            target: [40, 40],
          },
          {
            id: 'ui.button.icon.gear.pressed',
            file: 'ui/buttons/icon_gear_pressed.png',
            target: [40, 40],
          },
          {
            id: 'ui.button.icon.hammer.normal',
            file: 'ui/buttons/icon_hammer_normal.png',
            target: [40, 40],
          },
          {
            id: 'ui.button.icon.hammer.pressed',
            file: 'ui/buttons/icon_hammer_pressed.png',
            target: [40, 40],
          },
        ],
      },
      {
        kind: 'bbox',
        region: { xFrac: [0, 0.7], yFrac: [0.6, 0.8] },
        mergeGap: 15,
        items: [
          { id: 'ui.button.round.normal', file: 'ui/buttons/round_normal.png', target: [40, 40] },
          { id: 'ui.button.round.pressed', file: 'ui/buttons/round_pressed.png', target: [40, 40] },
          { id: 'ui.button.toggle.off', file: 'ui/buttons/toggle_off.png', target: [40, 40] },
          { id: 'ui.button.toggle.on', file: 'ui/buttons/toggle_on.png', target: [40, 40] },
        ],
      },
      {
        kind: 'single',
        region: { xFrac: [0, 0.52], yFrac: [0.78, 1.0] },
        trim: true,
        item: { id: 'ui.progress.frame', file: 'ui/buttons/progress_frame.png', target: [240, 40] },
      },
      {
        kind: 'bbox',
        region: { xFrac: [0.52, 1.0], yFrac: [0.78, 1.0] },
        mergeGap: 15,
        items: [
          {
            id: 'ui.progress.fill.green',
            file: 'ui/buttons/progress_fill_green.png',
            target: [220, 20],
          },
          {
            id: 'ui.progress.fill.orange',
            file: 'ui/buttons/progress_fill_orange.png',
            target: [220, 20],
          },
        ],
      },
    ],
  },

  // Irregular positions, very different sizes -> one fractional region per element
  // (located by visual inspection; each region has generous slack around its element).
  {
    file: 'ui_panels.png',
    groups: [
      {
        kind: 'single',
        region: { xFrac: [0, 1.0], yFrac: [0, 0.19] },
        trim: true,
        item: { id: 'ui.panel.bar_top', file: 'ui/panels/bar_top.png', target: [400, 48] },
      },
      {
        kind: 'single',
        region: { xFrac: [0, 0.53], yFrac: [0.2, 0.78] },
        trim: true,
        item: { id: 'ui.panel.frame_large', file: 'ui/panels/frame_large.png', target: [256, 256] },
      },
      {
        kind: 'single',
        region: { xFrac: [0.54, 0.78], yFrac: [0.2, 0.78] },
        trim: true,
        item: { id: 'ui.panel.card', file: 'ui/panels/card.png', target: [176, 176] },
      },
      {
        kind: 'single',
        region: { xFrac: [0.79, 1.0], yFrac: [0.2, 0.49] },
        trim: true,
        item: { id: 'ui.panel.badge', file: 'ui/panels/badge.png', target: [64, 64] },
      },
      {
        kind: 'single',
        region: { xFrac: [0.78, 1.0], yFrac: [0.49, 0.78] },
        trim: true,
        item: { id: 'ui.panel.tooltip', file: 'ui/panels/tooltip.png', target: [112, 80] },
      },
      {
        kind: 'single',
        region: { xFrac: [0, 1.0], yFrac: [0.78, 1.0] },
        trim: true,
        item: { id: 'ui.panel.bar_bottom', file: 'ui/panels/bar_bottom.png', target: [400, 48] },
      },
    ],
  },

  {
    file: 'ui_nav_icons.png',
    groups: [
      {
        kind: 'bbox',
        mergeGap: 15,
        items: [
          { id: 'ui.icon.nav.map.default', file: 'ui/nav/map_default.png', target: [TILE, TILE] },
          { id: 'ui.icon.nav.base.default', file: 'ui/nav/base_default.png', target: [TILE, TILE] },
          { id: 'ui.icon.nav.army.default', file: 'ui/nav/army_default.png', target: [TILE, TILE] },
          {
            id: 'ui.icon.nav.market.default',
            file: 'ui/nav/market_default.png',
            target: [TILE, TILE],
          },
          {
            id: 'ui.icon.nav.reports.default',
            file: 'ui/nav/reports_default.png',
            target: [TILE, TILE],
          },
          { id: 'ui.icon.nav.side.default', file: 'ui/nav/side_default.png', target: [TILE, TILE] },
          {
            id: 'ui.icon.nav.settings.default',
            file: 'ui/nav/settings_default.png',
            target: [TILE, TILE],
          },
          {
            id: 'ui.icon.nav.rankings.default',
            file: 'ui/nav/rankings_default.png',
            target: [TILE, TILE],
          },
        ],
      },
    ],
  },

  {
    file: 'ui_nav_icons_hover.png',
    groups: [
      {
        kind: 'bbox',
        mergeGap: 15,
        items: [
          { id: 'ui.icon.nav.map.hover', file: 'ui/nav/map_hover.png', target: [TILE, TILE] },
          { id: 'ui.icon.nav.base.hover', file: 'ui/nav/base_hover.png', target: [TILE, TILE] },
          { id: 'ui.icon.nav.army.hover', file: 'ui/nav/army_hover.png', target: [TILE, TILE] },
          { id: 'ui.icon.nav.market.hover', file: 'ui/nav/market_hover.png', target: [TILE, TILE] },
          {
            id: 'ui.icon.nav.reports.hover',
            file: 'ui/nav/reports_hover.png',
            target: [TILE, TILE],
          },
          { id: 'ui.icon.nav.side.hover', file: 'ui/nav/side_hover.png', target: [TILE, TILE] },
          {
            id: 'ui.icon.nav.settings.hover',
            file: 'ui/nav/settings_hover.png',
            target: [TILE, TILE],
          },
          {
            id: 'ui.icon.nav.rankings.hover',
            file: 'ui/nav/rankings_hover.png',
            target: [TILE, TILE],
          },
        ],
      },
    ],
  },

  {
    file: 'side_emblems.png',
    groups: [
      {
        kind: 'bbox',
        mergeGap: 24,
        items: [
          { id: 'emblem.side.beacon', file: 'emblems/side/beacon.png', target: [96, 96] },
          { id: 'emblem.side.silence', file: 'emblems/side/silence.png', target: [96, 96] },
        ],
      },
    ],
  },

  {
    file: 'faction_emblems.png',
    groups: [
      {
        kind: 'bbox',
        mergeGap: 24,
        items: [
          { id: 'emblem.faction.raiders', file: 'emblems/faction/raiders.png', target: [96, 96] },
          {
            id: 'emblem.faction.engineers',
            file: 'emblems/faction/engineers.png',
            target: [96, 96],
          },
          { id: 'emblem.faction.nomads', file: 'emblems/faction/nomads.png', target: [96, 96] },
        ],
      },
    ],
  },

  {
    file: 'battle_art.png',
    groups: [
      {
        kind: 'bbox',
        mergeGap: 24,
        items: [
          { id: 'battle.victory', file: 'battle/victory.png', target: [160, 160] },
          { id: 'battle.defeat', file: 'battle/defeat.png', target: [160, 160] },
        ],
      },
    ],
  },

  {
    file: 'medals.png',
    groups: [
      {
        kind: 'bbox',
        mergeGap: 24,
        items: [
          { id: 'medal.gold', file: 'medals/gold.png', target: [56, 56] },
          { id: 'medal.silver', file: 'medals/silver.png', target: [56, 56] },
          { id: 'medal.bronze', file: 'medals/bronze.png', target: [56, 56] },
          { id: 'medal.crossed_swords', file: 'medals/crossed_swords.png', target: [56, 56] },
          { id: 'medal.shield', file: 'medals/shield.png', target: [56, 56] },
          { id: 'medal.radio_wave', file: 'medals/radio_wave.png', target: [56, 56] },
        ],
      },
    ],
  },

  {
    file: 'logo_title.png',
    groups: [
      {
        kind: 'single',
        trim: true,
        item: { id: 'brand.logo', file: 'brand/logo.png', target: [640, 320] },
      },
    ],
  },

  {
    file: 'hero_landing.png',
    groups: [
      {
        kind: 'single',
        trim: false,
        item: { id: 'brand.hero_landing', file: 'brand/hero_landing.png', target: [1536, 1024] },
      },
    ],
  },
];

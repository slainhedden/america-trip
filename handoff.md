# Handoff

## Project state

This is a Vite + React + TypeScript trip planner in `/mnt/c/america-trip`.

Current major behavior already in place:
- Real National Park Service data is loaded through the official public NPS feed.
- The main UI is map-first and uses a satellite basemap.
- There are draggable and resizable floating panels for planner, route, catalog/state inspection, and featured parks.
- Users can set a custom start point by search or by arming map pin mode.
- Clicking the map in inspect mode reverse-resolves the state and shows parks for that state.
- Routing is live through an OSRM-compatible API.

## What changed most recently

I partially implemented smarter floating-panel layout behavior in [src/App.tsx](./src/App.tsx):
- Added `PANEL_MARGIN`, `PANEL_GAP`, and `PANEL_ORDER`.
- Added layout helpers:
  - `getOverlapArea`
  - `hasOverlap`
  - `buildCandidateLayout`
  - `getAnchoredPanelLayout`
  - `getPanelCandidates`
  - `pickBestPanelLayout`
  - `reconcilePanelLayouts`
- Updated `clampPanelLayout` to use shared margins.
- Reduced default panel sizes a bit in `getDefaultPanelLayouts()`.
- `loadPanelLayouts()` now runs through `reconcilePanelLayouts(...)`.

Intended effect:
- When a panel is dragged or resized, it should keep priority.
- Other panels should get nudged toward sensible anchor positions when there is room instead of only being hard-clamped to the viewport.

Important:
- I did **not** rerun `npm run build` after this latest `src/App.tsx` patch.
- The styling pass for the user’s latest visual direction was **not** completed yet.

## UI state right now

`src/styles.css` is still on the previous iteration:
- Satellite map is already in place.
- Floating panels exist.
- The theme is still more blue/ink and glassy than the user now wants.
- Many elements are still rounded.

The user asked for this next visual direction, which is still pending:
- smarter resize behavior so panels fit better when possible
- sharp-edged boxes instead of rounded ones
- dark green panel backgrounds
- subtle “bubbly” texture/surface treatment

## Latest user requests

The user interrupted the previous turn and added new product changes:

1. When a park is added to the route, add a tent.
2. Add the ability to add cities as route stops too.
3. Make the distinction between states slightly more clear on the map.

## What those requests likely mean in the code

### 1. Tent when a park is added

Current route stops are parks only, backed by `selectedParkIds: string[]`.

Likely UI options:
- show a tent glyph/icon beside park stops in the route panel
- show tent markers or a tent badge for selected park stops on the map

Most likely files:
- [src/App.tsx](./src/App.tsx)
- [src/styles.css](./src/styles.css)

### 2. Add cities as route stops

This requires a real data-model change. Right now the app only supports:
- one `startPoint`
- many selected parks by id

Current types in [src/types.ts](./src/types.ts):
- `TripState` only stores `startPoint` and `selectedParkIds`
- there is no mixed stop model for cities + parks

Current storage in [src/lib/storage.ts](./src/lib/storage.ts):
- persists the same simple `TripState`

Recommended direction:
- introduce a unified route-stop model, something like:
  - `RouteStop = { id, kind: 'park' | 'city', label, coordinates, parkId? }`
- persist ordered route stops instead of only `selectedParkIds`
- keep `startPoint` separate if desired, or fold it into the same route-stop model
- allow search results to be added as city stops, not only used as the trip origin
- update routing so it uses the ordered stop list instead of `startPoint + selectedParks`

Primary files to change:
- [src/types.ts](./src/types.ts)
- [src/lib/storage.ts](./src/lib/storage.ts)
- [src/App.tsx](./src/App.tsx)

### 3. Make states more distinct

Current map support:
- coordinate grid overlays
- state inspection via reverse geocoding
- no explicit state boundary highlight layer yet

Recommended next step:
- add a state boundary overlay or at least stronger boundary linework over the satellite map
- ideally highlight the currently inspected state polygon

Most likely files:
- [src/App.tsx](./src/App.tsx)
- possibly a new data/helper file if a boundary dataset is added

## Suggested next sequence

1. Run `npm run build` first to verify the latest `src/App.tsx` panel-reconciliation patch compiles.
2. Finish the pending UI pass in [src/styles.css](./src/styles.css):
   - sharp edges
   - dark green surfaces
   - subtle bubbly texture
3. Decide whether city stops should be:
   - additional stops after the origin, or
   - also usable as the origin and intermediate stops through one unified route model
4. Refactor route state around a mixed stop list.
5. Add tent affordances for selected park stops.
6. Add stronger state boundaries / selected-state highlighting.

## Sources already used earlier in this work

- ArcGIS World Imagery:
  - https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer
- MapLibre raster/style docs:
  - https://www.maplibre.org/maplibre-style-spec/sources/
- Nominatim reverse geocoding docs:
  - https://nominatim.org/release-docs/latest/api/Reverse/
- NPS public data sources:
  - https://www.nps.gov/findapark/index.htm
  - https://www.nps.gov/customcf/findapark/supportingDataJSON.cfm


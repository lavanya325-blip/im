# im

Channel selection integration between **Bus Configuration** and **Plot View**.

## Behavior

- Checking channels in MIL 1553 Configuration shows only those lanes in Plot View, using the same colors as the configuration panel (`CH1`–`CH8` palette).
- Checking multiple channels shows all selected lanes.
- If **no** channel is checked, Plot View defaults to **CH1**.
- MIL protocol decode rows (e.g. `MIL__1` / `BUS*` polygon lanes) are removed from the plot when channel selection is applied.

## Wiring

1. `BusConfigurationComponent` publishes selection via `ChannelPlotBridgeService` on every change (and once on init).
2. In `plot-view.component.ts`, follow `src/app/plot-view/PLOT_VIEW_EDITS.txt` to call `wirePlotChannelSelection` and update `colorFor`.

Optional parent template:

```html
<app-bus-configuration></app-bus-configuration>
<app-plot-view></app-plot-view>
```

The bridge service connects them without a shared parent when both are on the page.

## Tests

```bash
npm test
```

# Trackside soak fix

Base PR commit: `8e8b974344b5254ffa5d1ea2f637aa3e9ee8f719`.
Baseline: `9a6bce4f0623c0acfe945a05880fa863e8adc748`.

The initial headless probe found three global DBC fault subscriptions with a plain empty graph and an empty Trackside tab. The eight-tile layout added exactly its eight tile fields. Trackside does not count as a lap view in the subscription check.

An empty Trackside tab still displays the timeline. Its unconditional lap-band supplier starts lap analysis even without a lap view. The six extra fields are `Laps/SlipRatio`, `Laps/Number`, `Laps/Time`, `Laps/Distance`, `Laps/Sector`, and `Laps/DeltaToReference`. The mock backend has no diff against the baseline. The fault-demo flag was not enabled.

Measurements and final validation are pending.

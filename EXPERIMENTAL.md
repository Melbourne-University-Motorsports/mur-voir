# Experimental branch

This branch holds the features that were removed from `mur-voir/main` in the core rollback:

- ROS 2 and Foxglove live sources
- Raw Messages, Log and Image tabs
- point clouds, including the 36 commits from draft PR #1 that never merged
- URDF and TF
- spatial layers
- the 3D Field tab
- the MCAP importer

It isn't being developed. It gets no fixes or features from `mur-voir/main`.

It diverges from `mur-voir/main` from tag `pre-rollback` onward. To restore a single feature on `mur-voir/main`, revert that feature's removal commit there instead of merging this branch.

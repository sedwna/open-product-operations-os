# Operating-model version 2 migration

Version 2 adds the executable runtime contract, command development adapter settings, local Git
adapter settings, safe local workbook adapter settings, provider catalog, runtime schemas,
approvals, intake, metrics, dashboard, setup, and migrations.

`product-ops migrate <target>` reports the exact migration without writing. Supplying `--apply`
first stores the previous configuration under `.product-ops/migrations/<run-id>/`, then refreshes
generated scaffold with forced operational-row preservation.

Legacy projects without an `operations` object are treated as model version 1. Migration does not
enable an adapter, add credentials, alter protected workbook values, or delete historical rows.

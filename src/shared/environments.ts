// Until plugins E3 moves the Colima UI into plugins/colima/client: the renderer's (and the smokes')
// way to the plugin's shared half. The one core file that imports a plugin's file other than
// plugins/builtin.*.ts (scripts/pluginBoundaries.test.mjs). Re-exports only: put nothing else here.
export * from '../../plugins/colima/shared/environments.ts'

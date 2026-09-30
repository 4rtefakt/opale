// ti-brand-debian est disponible dans le webfont Tabler 3.19.0 (VENDORS.md).
export const isPullManaged = d => d.managed_by === 'pull'
export const osIcon = d => d.platform === 'linux' ? 'ti-brand-debian' : 'ti-brand-windows'

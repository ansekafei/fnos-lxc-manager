/* lib/distro.js —— 按容器系统名选发行版图标
 *
 * 图标来自 simple-icons（CC0），放在 ui/icons/ 下，随包一起发。
 * 名称匹配不分大小写，按关键字命中；认不出来返回空字符串，调用方回退到状态点。
 */

const TABLE = [
  ['alma', 'almalinux'],
  ['alpine', 'alpinelinux'],
  ['arch', 'archlinux'],
  ['centos', 'centos'],
  ['debian', 'debian'],
  ['fedora', 'fedora'],
  ['gentoo', 'gentoo'],
  ['kali', 'kalilinux'],
  ['mint', 'linuxmint'],
  ['nixos', 'nixos'],
  ['opensuse', 'opensuse'],
  ['suse', 'opensuse'],
  ['openwrt', 'openwrt'],
  ['red hat', 'redhat'],
  ['redhat', 'redhat'],
  ['rhel', 'redhat'],
  ['rocky', 'rockylinux'],
  ['ubuntu', 'ubuntu'],
  ['void', 'voidlinux'],
];

/** 系统名 → 图标名（认不出返回 ''） */
export function distroKey(osName) {
  const s = String(osName || '').toLowerCase();
  if (!s) return '';
  for (const [needle, key] of TABLE) {
    if (s.includes(needle)) return key;
  }
  return '';
}

/** 系统名 → 图标 URL（认不出返回 ''） */
export function distroIcon(osName) {
  const key = distroKey(osName);
  return key ? new URL(`../../icons/${key}.svg`, import.meta.url).href : '';
}

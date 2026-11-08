// Front-end themes selectable in site settings. Changing the theme only takes effect after the site is republished.
// The first entry is the default (defaultSiteTheme): new installs and databases that never saved siteTheme use it,
// and unknown ids fall back to it.
// darkOnly themes ignore the reader's light/dark choice and hide the toggle.
export const siteThemes = [
 { id: 'kiln', name: '窑火 Kiln', description: 'Claude 风格的暖调深色、余烬粒子与像素吉祥物，仅深色。', darkOnly: true },
 { id: 'dream', name: 'Dream 星夜', description: '原站背景图、星点与流星，支持明暗切换。', darkOnly: false }
];
export const defaultSiteTheme = siteThemes[0].id;
export const themeOf = id => siteThemes.find(t => t.id === id) || siteThemes[0];

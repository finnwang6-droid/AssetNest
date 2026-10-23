// Original AssetNest SVG palette, licensed under MIT.
export const folderIcons=["folder","library","box","photo","video","music","book","camera","palette","star","heart","tag","home","globe","clock","shield"];
export const folderColors={"":"#bcbcbc","red":"#ff4949","orange":"#ff9400","yellow":"#ffcf00","green":"#30ce63","aqua":"#28c8d9","blue":"#12a3ed","purple":"#be86f2","pink":"#ff89cc"};
export function folderIconUrl(name){return '/vendor/folder-icons/'+(folderIcons.includes(name)?name:'folder')+'.svg';}

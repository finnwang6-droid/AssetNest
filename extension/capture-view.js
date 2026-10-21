// Page hints are kept separate from dimensions verified after saving.
export function candidateLabel(candidate={},withSize=true) {
 const source=candidate.source||'current';
 const label=({'current':'当前显示图',src:'页面地址',srcset:'响应式候选',picture:'画框候选','linked-image':'图片链接',background:'背景图','data-src':'延迟加载','data-lazy-src':'延迟加载','data-lazy':'延迟加载','data-url':'页面候选'})[source]||(/^data-(original|full|full-src|zoom-image|large-image)$/.test(source)?'页面标记原图':source);
 return label+(!withSize?'':candidate.width?' · '+candidate.width+'w':candidate.density>1?' · '+candidate.density+'x':' · 尺寸待下载确认');
}
export function resultText(result) {
 const state=result.status==='failed'?'失败':result.verified?(result.status==='duplicate'?'已核验 · 使用已有素材':'已核验 · 已保存'):'已处理 · 未提供校验信息';
 const dimensions=result.width&&result.height?result.width+' × '+result.height:'';
 const size=result.size?(result.size<1048576?(result.size/1024).toFixed(1)+' KB':(result.size/1048576).toFixed(2)+' MB'):'';
 const location=result.destination?.path;
 return [state+'：'+result.name,[dimensions,size,result.candidateSource?candidateLabel({source:result.candidateSource},false):''].filter(Boolean).join(' · '),location?'保存位置：'+location+' · 分类 '+(result.destination.folders?.length||0)+' 个':''].filter(Boolean).join('\n');
}

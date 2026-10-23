import {smartFields,smartOperators} from './public/smart-fields.js';
const error=message=>Object.assign(Error(message),{status:400});
export function safePattern(value){
 // Keep regex evaluation bounded: no groups, alternation, backreferences or
 // multiple repetitions. Common anchored expressions and character sets work.
 if(value.length>128||/[()|{}]/.test(value)||/\\[1-9]/.test(value)||(value.match(/(?<!\\)[*+?]/g)||[]).length>1)throw error('正则仅支持基础表达式、字符集和最多一个重复符号，不支持分组或回溯引用');
 try{return new RegExp(value,'iu');}catch{throw error('正则表达式无效');}
}
export function validateRules(input){
 let count=0;
 function visit(node,depth){
  if(!node||typeof node!=='object'||Array.isArray(node)||depth>4||++count>80)throw error('规则最多 4 层、80 个节点');
  if(Array.isArray(node.rules)){
   if(!['all','any'].includes(node.match)||typeof(node.negate??false)!=='boolean'||!node.rules.length)throw error('条件组需要至少一条规则，并选择任一项或全部');
   return {match:node.match,negate:!!node.negate,rules:node.rules.map(n=>visit(n,depth+1))};
  }
  const type=smartFields[node.field]?.[1];if(!type||!smartOperators[type].some(([op])=>op===node.op))throw error('规则字段或比较方式无效');
  let value=node.value??'';if(['empty','notEmpty'].includes(node.op))value='';
  else if(type==='number'){if(value==='')throw error('请填写数值条件');value=Number(value);if(!Number.isFinite(value)||value<0||value>1e15||node.field==='rating'&&value>5)throw error('数值条件超出范围');}
  else if(type==='date'){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(new Date(value+'T00:00:00').getTime())||typeof value==='string'&&new Date(value+'T12:00:00').getDate()!==Number(value.slice(8,10)))throw error('日期条件无效');}
  else if(type==='shape'){if(!['landscape','portrait','square'].includes(value))throw error('形状条件无效');}
  else if(type==='boolean'){if(typeof value!=='boolean')throw error('标注条件无效');}
  else if(typeof value!=='string'||!value.trim()||value.length>1000)throw error('请填写规则内容');
  if(type==='color'&&!/^#[a-f0-9]{6}$/i.test(value))throw error('颜色需要为 #RRGGBB');if(node.op==='regex')safePattern(value);
  return {field:node.field,op:node.op,value};
 }
 return visit(input,0);
}
export function compileRules(input,{w,h,ratio}){
 const params=[],bind=value=>{params.push(value);return '?';};
 const meta=key=>`json_extract(i.metadata,'$.${key}')`;
 const fields={name:'s.name',filename:"s.name||CASE WHEN substr(s.name,-length(s.ext)-1)='.'||s.ext THEN '' ELSE '.'||s.ext END",ext:'s.ext',tags:"coalesce((SELECT group_concat(value,char(10)) FROM json_each(s.tags)),'')",folder:"coalesce((SELECT group_concat(value,char(10)) FROM json_each(s.folders)),'')",folderName:"coalesce((SELECT group_concat(json_extract(d.metadata,'$.name'),char(10)) FROM folders d WHERE d.id IN (SELECT value FROM json_each(s.folders))),'')",url:`coalesce(${meta('url')},'')`,annotation:`coalesce(${meta('annotation')},'')`,width:w,height:h,size:'s.size',rating:'s.star',star:'(s.star>0)',duration:`coalesce(mi.duration,${meta('duration')})`,dateAdded:'s.created',dateCreated:meta('btime'),dateModified:`coalesce(${meta('lastModified')},${meta('mtime')})`};
 function visit(node){
  if(node.rules){const sql='('+node.rules.map(n=>'coalesce('+visit(n)+',0)').join(node.match==='all'?' AND ':' OR ')+')';return node.negate?'NOT '+sql:sql;}
  const {field,op,value}=node,type=smartFields[field][1],col=fields[field];
  if(field==='folder'){if(op==='empty')return 'json_array_length(s.folders)=0';if(op==='notEmpty')return 'json_array_length(s.folders)>0';return (op==='ne'?'NOT ':'')+'EXISTS(SELECT 1 FROM json_each(s.folders) WHERE value='+bind(value)+')';}
  if(type==='color'){const rgb=[1,3,5].map(n=>parseInt(value.slice(n,n+2),16));const terms=rgb.map((v,n)=>`(json_extract(p.value,'$.color[${n}]')-${bind(v)})*(json_extract(p.value,'$.color[${n}]')-${bind(v)})`);return (op==='ne'?'NOT ':'')+`EXISTS(SELECT 1 FROM json_each(CASE WHEN f.status='ready' THEN f.palette ELSE coalesce(${meta('palettes')},'[]') END) p WHERE ${terms.join('+')}<=6400)`;}
  if(type==='shape'){const clause=value==='square'?`(${ratio}=1)`:value==='landscape'?`(${ratio}>1)`:`(${ratio}<1)`;return op==='ne'?`(${ratio} IS NOT NULL AND NOT ${clause})`:clause;}
  if(type==='date'){const start=new Date(value+'T00:00:00').getTime(),end=new Date(value+'T23:59:59.999').getTime();return op==='eq'?`(${col}>=${bind(start)} AND ${col}<=${bind(end)})`:op==='lt'?`${col}<${bind(start)}`:`${col}>${bind(end)}`;}
  if(type==='number'||type==='boolean')return `${col}${{eq:'=',ne:'<>',gt:'>',gte:'>=',lt:'<',lte:'<='}[op]}${bind(typeof value==='boolean'?Number(value):value)}`;
  const text=`lower(coalesce(${col},''))`,v=value.normalize('NFKC').toLocaleLowerCase('en-US');
  if(op==='empty')return `${text}=''`;if(op==='notEmpty')return `${text}<>''`;
  if(op==='regex')return `assetnest_regex(${bind(value)},${col})=1`;
  if(op==='contains'||op==='notContains')return `instr(${text},${bind(v)})${op==='contains'?'>0':'=0'}`;
  if(op==='startsWith')return `substr(${text},1,length(${bind(v)}))=${bind(v)}`;
  if(op==='endsWith')return `substr(${text},-length(${bind(v)}))=${bind(v)}`;
  return `${text}=${bind(v)}`;
 }
 return {sql:visit(validateRules(input)),params};
}

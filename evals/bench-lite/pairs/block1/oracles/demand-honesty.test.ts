// Independent historical demand, settlement and rendered-copy contracts for #727.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { testEnv } from '../tests/setup/test-env';
import { startDatabase } from '#benchmark/database';
let service:any, fixtures:any, queries:any, reads:any, pulse:any, ui:any, now:number, browser:JSDOM;
const options={days:7,limit:100,maxPerRequester:100};
const sample='Which Base DEX aggregators settle x402 payments today?';
const normalize=(text:string)=>text.trim().toLowerCase().replace(/\s+/g,' ');
const names=(rows:any[])=>rows.map(row=>normalize(row.query)).sort();
const ago=(hours:number)=>new Date(now-hours*3600000);
function ready(){expect(typeof queries.getConvertedQuestions,'converted tier is available').toBe('function');}
beforeAll(async()=>{
  for(const [key,value] of Object.entries(testEnv))vi.stubEnv(key,value);
  vi.stubEnv('POSTGRES_URL',process.env.BENCHMARK_DATABASE_URL!);vi.stubEnv('POSTGRES_URL_NON_POOLING',process.env.BENCHMARK_DATABASE_URL!);
  vi.stubGlobal('fetch',()=>{throw new Error('Unexpected outbound request');});
  browser=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://fictional.example',pretendToBeVisual:true});
  for(const key of ['window','self','document','navigator','Element','HTMLElement','Node','DocumentFragment','MutationObserver'])vi.stubGlobal(key,key==='window'?browser.window:(browser.window as any)[key]);
  vi.stubGlobal('requestAnimationFrame',browser.window.requestAnimationFrame.bind(browser.window));vi.stubGlobal('cancelAnimationFrame',browser.window.cancelAnimationFrame.bind(browser.window));
  vi.stubGlobal('getComputedStyle',browser.window.getComputedStyle.bind(browser.window));vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
  vi.stubGlobal('matchMedia',(query:string)=>({matches:false,media:query,onchange:null,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return false;}}));
  browser.window.Element.prototype.scrollIntoView=()=>{};browser.window.Element.prototype.hasPointerCapture=()=>false;browser.window.Element.prototype.setPointerCapture=()=>{};browser.window.Element.prototype.releasePointerCapture=()=>{};
  const schema=await import('../lib/db/schema');service=await startDatabase(schema);fixtures=await import('../tests/integration/_support/fixtures');
  queries=await import('../lib/search-telemetry');reads=await import('../lib/trending-demand');pulse=await import('../lib/agent-search-demand');
  ui={...(await import('../app/trending/_components/demand-body')),...(await import('../app/_components/agents-asking')),...(await import('../app/_components/agent-drawer'))};
},60000);
afterAll(async()=>{if(service)await service.close();browser?.window.close();vi.unstubAllGlobals();vi.unstubAllEnvs();});
beforeEach(async()=>{await service.pool.query('TRUNCATE search_queries,hidden_search_terms,lookups,creators CASCADE');now=new Date((await service.pool.query('SELECT now() AS epoch')).rows[0].epoch).getTime();});
async function ask(text:string|null,decision='candidates',count=2,hours=30,client:string|null=null,requester?:string){
  const ids:string[]=[];for(let i=0;i<count;i++){const id=randomUUID();ids.push(id);await service.pool.query('INSERT INTO lookups(id,generalized_query,decision,candidate_count,requester_hmac,client_name,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,text,decision,decision==='miss'?0:1,requester??randomUUID(),client,ago(hours+count-i)]);}return ids;
}
async function sale(id:string|null,self=false){const owner=await fixtures.makeCreator(service);const post=await fixtures.makePost(service,owner);await fixtures.makePayment(service,post,{lookupId:id,searchAttributed:id!==null,...(self?{payerAddress:owner.walletAddress}:{})});}
async function term(text:string,count=3,matched=true){for(let i=0;i<count;i++)await service.pool.query("INSERT INTO search_queries(id,query,source,searcher_hash,result_count,created_at) VALUES($1,$2,'agent',$3,$4,$5)",[randomUUID(),text,randomUUID(),matched?1:0,ago(30)]);}
function documentFor(component:any,props:any){const markup=renderToStaticMarkup(createElement(ui.AgentDrawerProvider,null,createElement(component,props)));return new JSDOM(markup);}

it('uses one documented answer sample constant without requiring new exports during collection',async()=>{
  expect(existsSync(join(process.cwd(),'lib/payments/answer-example.ts'))).toBe(true);const exported=await import('../lib/payments/answer-example');expect(exported.ANSWER_BODY_EXAMPLE).toEqual({question:sample,freshWithin:'P30D'});
});
it.each(['getAgentQuestions','getAnsweredQuestions','getWaitingQuestions','getPendingAgentQuestions','getConvertedQuestions'])('%s removes sample, code, operator and probe rows with real positive controls',async method=>{
  if(method==='getConvertedQuestions')ready();const decision=method==='getWaitingQuestions'?'miss':'candidates';
  const good=['why x402?','Which silver optical mount holds steady?'];
  const bad=[sample,'  '+sample.toUpperCase().replace(/ /g,'   ')+' ','a question','zzq_probe_oracle_fresh','test2','testing_03','hi','12345','Which hidden optical mount holds steady?'];
  for(const text of [...good,...bad]){const ids=await ask(text,decision);if(method==='getConvertedQuestions')await sale(ids[0]);}
  await service.pool.query('INSERT INTO hidden_search_terms(term,reason) VALUES($1,$2)',[normalize(bad.at(-1)!),'synthetic moderation']);
  for(const client of ['tenjin-eval','TENJIN-ADMIN-PROBE']){const ids=await ask('Which '+client+' optical fixture works?',decision,2,30,client);if(method==='getConvertedQuestions')await sale(ids[0]);}
  expect(names(await queries[method](service.db,options))).toEqual(good.map(normalize).sort());
});
it('shape remains narrow and preserves meaningful short, long and non-ASCII questions',()=>{
  ready();for(const text of ['why','x402?','测试三','a'.repeat(100),'testimony','testing process'])expect(queries.isPublishableQuestionShape(text),text).toBe(true);
  for(const text of ['',' hi ','12345','!!!','test','TEST2','testing_03'])expect(queries.isPublishableQuestionShape(text),text).toBe(false);
});
it('pending keeps fresh and single-source questions while applying the same safety filters',async()=>{
  ready();await ask('Why is the amber optical mount drifting?','miss',1,1);await ask('Why is the violet optical mount drifting?','candidates',1,40);await ask('Why is the silver optical mount drifting?');
  expect(names(await queries.getAgentQuestions(service.db,options))).toEqual(['why is the silver optical mount drifting?']);
  expect(names(await queries.getPendingAgentQuestions(service.db,options))).toEqual(['why is the amber optical mount drifting?','why is the silver optical mount drifting?','why is the violet optical mount drifting?']);
});
it('one settled third-party buyer replaces the requester floor and self-pay cannot convert demand',async()=>{
  ready();const paid=await ask('How can amber tasks resume?','candidates',1,30);await sale(paid[0]);const self=await ask('How can the owner seed this?','candidates',1,31);await sale(self[0],true);await sale(null);
  expect(names(await queries.getConvertedQuestions(service.db,{...options,days:30}))).toEqual(['how can amber tasks resume?']);
  expect(await queries.getAgentQuestions(service.db,options)).toEqual([]);
});
it('any linked lookup converts its normalized group even if the latest query is an unpaid MISS',async()=>{
  ready();const id=(await ask('Why can amber workers retry?','candidates',1,35))[0];await sale(id);await ask('  WHY can   amber workers RETRY? ','miss',1,29);
  const rows=await queries.getConvertedQuestions(service.db,{...options,days:30});expect(rows).toHaveLength(1);expect(normalize(rows[0].query)).toBe('why can amber workers retry?');expect(rows[0]).toMatchObject({answered:false,requesters:2});expect(names(await queries.getWaitingQuestions(service.db,options))).toEqual(['why can amber workers retry?']);
});
it('conversion uses the lookup window and persistence delay while the longer page window retains older sales',async()=>{
  ready();for(const [text,hours]of[['Why is amber delayed?',1],['Why is violet useful?',480],['Why is silver expired?',768]]as const)await sale((await ask(text,'candidates',1,hours))[0]);
  expect(names(await queries.getConvertedQuestions(service.db,{...options,days:30}))).toEqual(['why is violet useful?']);expect(await queries.getConvertedQuestions(service.db,options)).toEqual([]);
});
it('converted rows obey display and requester caps and expose no identity or precise timestamp',async()=>{
  ready();for(let i=0;i<4;i++)await sale((await ask(`Why is optical configuration ${i} drifting?`,'candidates',1,30+i,null,'same-reader'))[0]);
  for(const bad of ['Contact me at private@example.com','A'.repeat(300)])await sale((await ask(bad,'candidates',1,30))[0]);
  const rows=await queries.getConvertedQuestions(service.db,{...options,maxPerRequester:2});expect(rows).toHaveLength(2);for(const row of rows){expect(Object.keys(row).sort()).toEqual(['answered','askedOn','query','requesters']);expect(row.askedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);}
});
it('pulse excludes only the documented answer sample while retaining null text and catalog samples',async()=>{
  await ask(sample,'candidates',3);await ask('Why is amber useful?','candidates',1);await ask('Why is violet missing?','miss',1);await ask(null,'candidates',1);await term(sample);
  expect(await pulse.getAgentSearchDemandSummary(service.db,{days:30,minSearchers:3})).toEqual({total:6,matched:5,missed:1});expect(names(await queries.getTopSearchTerms(service.db,{days:30,limit:25,minCount:3,source:'agent'}))).toEqual([normalize(sample)]);
});
it('real page readers feed bought, waiting, matched sections with truthful counts and labels',async()=>{
  ready();await sale((await ask('How can amber tasks resume?','candidates',1,30))[0]);await sale((await ask('Why can violet tasks retry?','candidates',1,480))[0]);await ask('How should cobalt queues drain?','miss',3,31);await ask('When should silver workers stop?','candidates',2,27);await sale((await ask('How can the owner seed this?','candidates',1,31))[0],true);
  const result=await reads.readTrendingPageDemand(service.db);expect(result.summary).toEqual({total:8,matched:5,missed:3});expect(names(result.converted)).toEqual(['how can amber tasks resume?','why can violet tasks retry?']);expect(names(result.waiting)).toEqual(['how should cobalt queues drain?']);expect(names(result.answered)).toEqual(['when should silver workers stop?']);
  const dom=documentFor(ui.DemandBody,{...result,windowDays:30,questionDays:7,convertedDays:30});
  try {
    const d=dom.window.document;
    const sections=[...d.querySelectorAll('section')].filter(section=>section.querySelector('h2'));
    expect(sections).toHaveLength(3);
    expect(sections[0].querySelector('h2')?.textContent).toBe('Answered and bought');
    // The work order specifies populations and order, not the other headings or
    // whether a paid row prints a buyer label versus a truthful requester count.
    for(const [index,rows] of [result.converted,result.waiting,result.answered].entries()) {
      const text=normalize(sections[index].textContent??'');
      for(const row of rows)expect(text).toContain(normalize(row.query));
      for(const other of [result.converted,result.waiting,result.answered].filter((_,i)=>i!==index))
        for(const row of other)expect(text).not.toContain(normalize(row.query));
    }
    expect(sections[2].textContent).toMatch(/candidate|match/i);
    expect(sections[2].textContent).not.toContain('Each answer now earns on every read');
    // Counts must be truthful; "candidate matches" is as valid as the legacy
    // "answered" pulse wording retained by the historical reference.
    const pulse=[...d.querySelectorAll('p')].find(p=>/\b8(?:\s+\w+){0,2}\s+search/i.test(p.textContent??''));
    expect(pulse).toBeDefined();
    expect(pulse!.textContent).toMatch(/\b5(?:\s+\w+){0,2}\s+(?:answer|match|candidate)/i);
    expect(pulse!.textContent).toMatch(/\b3(?:\s+\w+){0,2}\s+(?:wait|miss|unanswered)/i);
    expect(pulse!.textContent).toMatch(/30\s+days/);
  } finally {dom.window.close();}
});

it('empty landing is explicit, while populated landing keeps the filtered seven-day subset',async()=>{
  const empty=await reads.readLandingQuestions(service.db);expect(empty).toEqual([]);
  let dom=documentFor(ui.AgentsAsking,{questions:empty});
  try {
    const d=dom.window.document;
    expect(d.querySelectorAll('li')).toHaveLength(0);
    expect([...d.querySelectorAll('p')].some(p=>/quiet|no question|nothing|not enough|empty/i.test(p.textContent??''))).toBe(true);
    expect([...d.querySelectorAll('button,a')].some(x=>/set up.*agent/i.test(x.textContent??''))).toBe(true);
    expect(d.querySelector('a[href="/trending"]')).not.toBeNull();
  } finally {dom.window.close();}
  await ask('Why do amber workers retry?');await ask(sample);
  const rows=await reads.readLandingQuestions(service.db);expect(names(rows)).toEqual(['why do amber workers retry?']);
  dom=documentFor(ui.AgentsAsking,{questions:rows});
  try {
    const d=dom.window.document;
    expect(d.querySelectorAll('li')).toHaveLength(1);
    expect(normalize(d.querySelector('li')!.textContent!)).toContain('why do amber workers retry?');
    expect(d.querySelector('li')!.textContent).toContain('asked by 2');
  } finally {dom.window.close();}
});

it('quiet landing reaches actual setup instructions through a dialog or the existing agents page',async()=>{
  const {createRoot}=await import('react-dom/client');const host=document.createElement('div');document.body.appendChild(host);const mounted=createRoot(host);
  try {
    await act(async()=>{mounted.render(createElement(ui.AgentDrawerProvider,null,createElement(ui.AgentsAsking,{questions:[]})));});
    const action=[...host.querySelectorAll('button,a')].find(x=>/set up.*agent/i.test(x.textContent??''));
    expect(action).toBeDefined();
    if(action!.tagName==='A') {
      // Exercise the actual local destination; a missing page, empty setup page,
      // unrelated URL or a placeholder '#' does not satisfy a working action.
      expect(action!.getAttribute('href')).toBe('/agents');
      const page=(await import('../app/agents/page')).default;
      const instructions=(await import('../app/_components/agent-prompt')).AGENT_SETUP_PROMPT;
      const dom=documentFor(page,{});
      try {
        expect(dom.window.document.body.textContent).toContain(instructions);
        expect([...dom.window.document.querySelectorAll('button')].some(x=>/copy prompt/i.test(x.textContent??''))).toBe(true);
      } finally {dom.window.close();}
    } else {
      await act(async()=>{(action as HTMLElement).click();});
      let dialog=document.querySelector('[role="dialog"]');expect(dialog).not.toBeNull();
      const instructions=(await import('../app/_components/agent-prompt')).AGENT_SETUP_PROMPT;
      const {publicEnv}=await import('../lib/env-public');
      const mcpUrl=publicEnv.NEXT_PUBLIC_APP_URL.replace(/\/$/,'')+'/api/mcp';
      const hasPrompt=(node:Element)=>node.textContent?.includes(instructions)&&[...node.querySelectorAll('button')].some(x=>/copy prompt/i.test(x.textContent??''));
      const hasConnector=(node:Element)=>node.textContent?.includes(mcpUrl)&&node.querySelector('a[href="https://claude.ai/settings/connectors"]')!==null&&/custom connector/i.test(node.querySelector('ol')?.textContent??'');
      if(!hasPrompt(dialog!)&&!hasConnector(dialog!)) {
        // The preexisting drawer may open on its chooser or connector door.
        // Follow its real terminal choice instead of requiring a deep link.
        const terminal=[...dialog!.querySelectorAll('button')].find(x=>/in a terminal/i.test(x.textContent??''));
        expect(terminal).toBeDefined();
        await act(async()=>{(terminal as HTMLElement).click();});
        dialog=document.querySelector('[role="dialog"]');expect(dialog).not.toBeNull();
      }
      expect(Boolean(hasPrompt(dialog!)||hasConnector(dialog!))).toBe(true);
    }
  } finally {await act(async()=>mounted.unmount());host.remove();}
});

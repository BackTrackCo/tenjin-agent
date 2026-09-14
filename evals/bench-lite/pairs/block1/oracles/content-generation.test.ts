// Independent historical #670 contracts. All providers, payment effects and auth are synthetic.
import { randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { testEnv } from '../tests/setup/test-env';
import { startDatabase } from '#benchmark/database';
let service: any, schema: any, fixtures: any, generation: any, chunks: any, sweep: any, scheduling: any, routes: any;
let active: any, address: string;
const pending: (() => Promise<unknown>)[] = [];
const budget = vi.fn(async () => true);
vi.mock('../lib/db', () => ({ get db() { return service.db; } }));
vi.mock('../lib/embeddings', async original => ({ ...await original<any>(), getEmbeddingProvider: () => active, tryConsumeEmbeddingCall: () => budget() }));
vi.mock('../lib/after-response', () => ({ afterResponse: (fn: () => Promise<unknown>) => pending.push(fn) }));
vi.mock('../lib/revalidate', () => ({ revalidatePost: () => {} }));
vi.mock('../lib/payments/deploy-split', () => ({ deployCreatorSplitInBackground: async () => {} }));
vi.mock('../lib/payments/bazaar-register', () => ({ registerPostInBackground: async () => {} }));
vi.mock('../lib/auth/with-auth', () => ({ withAuth: (handler: any) => (req: Request) => handler(req, { address }) }));
const title = 'Independent optics';
const A = 'Alpha optical passage. '.repeat(62).trim();
const B = 'Beta independent measurements. '.repeat(46).trim();
const C = 'Gamma calibration record. '.repeat(55).trim();
const vector = (i = 0) => { const v = Array(1536).fill(0); v[i] = 1; return v; };
const hash = (text: string, model = 'oracle-prior') => createHash('sha256').update(model + '\0' + text.trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex');
const provider = () => ({ model: 'oracle-prior', embed: vi.fn(async (texts: string[]) => texts.map((_, i) => vector(i))) });
function ready() { expect(existsSync(join(process.cwd(), 'lib/content-embeddings.ts')), 'historical generation feature exists').toBe(true); }
beforeAll(async () => {
  for (const [k,v] of Object.entries(testEnv)) vi.stubEnv(k,v);
  vi.stubEnv('POSTGRES_URL', process.env.BENCHMARK_DATABASE_URL!); vi.stubEnv('POSTGRES_URL_NON_POOLING', process.env.BENCHMARK_DATABASE_URL!);
  vi.stubGlobal('fetch', () => { throw new Error('Unexpected outbound request'); });
  schema = await import('../lib/db/schema'); service = await startDatabase(schema); fixtures = await import('../tests/integration/_support/fixtures');
  if (existsSync(join(process.cwd(), 'lib/content-embeddings.ts'))) {
    generation = await import('../lib/content-embeddings'); chunks = await import('../lib/content-chunks'); sweep = await import('../lib/embeddings-sweep'); scheduling = await import('../lib/embed-on-publish');
    routes = { create: (await import('../app/api/posts/route')).POST, update: (await import('../app/api/posts/[id]/route')).PUT };
  }
}, 60000);
afterAll(async () => { if (service) await service.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
beforeEach(async () => { await service.pool.query('TRUNCATE creators CASCADE'); active = provider(); pending.length = 0; budget.mockReset(); budget.mockResolvedValue(true); });
async function post(body = A, status = 'published', owner?: any) { owner ??= await fixtures.makeCreator(service); return fixtures.makePost(service, owner, { title, bodyMd: body, status, price: '0.00', publishedAt: new Date(Date.now()-86400000) }); }
async function edit(id: string, body: string) { await service.pool.query('UPDATE posts SET body_md=$1 WHERE id=$2', [body,id]); }
async function rows(id: string) { return (await service.pool.query('SELECT text_hash,chunk_idx,model,source,embedding::text AS vector FROM content_embeddings WHERE post_id=$1 ORDER BY chunk_idx',[id])).rows; }
async function dirty(id: string) { return (await service.pool.query('SELECT updated_at IS DISTINCT FROM content_embedded_at AS dirty FROM posts WHERE id=$1',[id])).rows[0].dirty; }
function deferred<T>() { let resolve!: (x:T)=>void; const promise = new Promise<T>(r=>{resolve=r}); return { promise, resolve }; }
it('installs the physical content schema, dimension/uniqueness/FK constraints and cascading cleanup', async () => {
  ready(); const columns = (await service.pool.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_name='content_embeddings'")).rows;
  expect(columns.map((x:any)=>x.column_name)).toEqual(expect.arrayContaining(['post_id','chunk_idx','text_hash','model','embedding','source','created_at']));
  expect((await service.pool.query("SELECT indexdef FROM pg_indexes WHERE tablename='content_embeddings'")).rows.some((x:any)=>/hnsw.*vector_cosine_ops/i.test(x.indexdef))).toBe(true);
  const p=await post(), q=await post(); await generation.embedPostContent(service.db,active,p.id); const row=(await rows(p.id))[0];
  const insert=(id:string,width=1536)=>service.pool.query('INSERT INTO content_embeddings(post_id,chunk_idx,source,text_hash,model,embedding) VALUES($1,0,\'body\',$2,$3,$4)',[id,row.text_hash,row.model,JSON.stringify(Array(width).fill(0).map((_,i)=>i===0?1:0))]);
  await expect(insert(p.id)).rejects.toThrow(); await insert(q.id); await expect(insert(randomUUID())).rejects.toThrow();
  await service.pool.query('DELETE FROM content_embeddings WHERE post_id=$1',[q.id]); await expect(insert(q.id,3)).rejects.toThrow();
  await service.pool.query('DELETE FROM posts WHERE id=$1',[p.id]); expect(await rows(p.id)).toEqual([]);
});
it('chunks literal Markdown, strips standalone comments and leaves no chunks for empty content', () => {
  ready(); const plain = chunks.contentChunks('  Independent heading  ','First paragraph.\n\n<!--paywall-->\n\nSecond paragraph.');
  expect(plain).toHaveLength(1); expect(plain[0]).toContain('Independent heading');
  expect(plain[0].indexOf('Independent heading')).toBeLessThan(plain[0].indexOf('First paragraph.'));
  expect(plain[0]).toContain('First paragraph.\n\nSecond paragraph.'); expect(plain[0]).not.toContain('<!--paywall-->');
  for (const body of ['', '  ', '<!--paywall-->']) expect(chunks.contentChunks(title,body)).toEqual([]);
  expect(chunks.contentChunks('', 'Literal paragraph.')).toEqual(['Literal paragraph.']);
  const fence='```js\n# literal\n\nconst n=3;\n```'; expect(chunks.contentChunks(title,fence).join('\n')).toContain(fence);
});
it('preserves structural order, body caps, Unicode and full unbounded historical coverage', () => {
  ready(); const result=chunks.contentChunks(title,A+'\n\n'+B+'\n\n'+C); expect(result).toHaveLength(3); for (const [i, body] of [A,B,C].entries()) { expect(result[i]).toContain(body); expect(result[i].indexOf(title)).toBeGreaterThanOrEqual(0); expect(result[i].indexOf(title)).toBeLessThan(result[i].indexOf(body)); }
  const unicode='x'.repeat(1199)+'🛰️'.repeat(900); const cut=chunks.contentChunks('',unicode);
  expect(cut.every((x:string)=>x.length<=2000&&x.isWellFormed())).toBe(true); expect(cut.join('')).toBe(unicode);
  const many=Array.from({length:270},(_,i)=>`## Station ${i}\n\n${A}`); const all=chunks.contentChunks(title,many.join('\n\n')).join('\n'); expect(all).toContain('Station 269');
  expect(chunks.contentChunks(title,'Small heading.\n\n'+A)).toHaveLength(1);
});
it('batches cardless content once and stores literal model/text identities with no repeated provider spend', async () => {
  ready(); const p=await post([A,B,C].join('\n\n')); const result=await generation.embedPostContent(service.db,active,p.id); expect(result).toEqual({inserted:3,deleted:0,skipped:null});
  expect(active.embed.mock.calls).toEqual([[chunks.contentChunks(title,[A,B,C].join('\n\n')),{timeoutMs:10000}]]);
  expect((await rows(p.id)).map((x:any)=>[x.text_hash,x.chunk_idx,x.source,x.vector])).toEqual(chunks.contentChunks(title,[A,B,C].join('\n\n')).map((x:string,i:number)=>[hash(x),i,'body',JSON.stringify(vector(i))]));
  budget.mockClear(); expect(await generation.embedPostContent(service.db,active,p.id)).toEqual({inserted:0,deleted:0,skipped:null}); expect(active.embed).toHaveBeenCalledTimes(1); expect(budget).not.toHaveBeenCalled(); expect(await dirty(p.id)).toBe(false);
});
it('deduplicates, retains vectors across reorder and recomputes only new body or title/model identities', async () => {
  ready(); const p=await post([A,B,A].join('\n\n')); await generation.embedPostContent(service.db,active,p.id); expect(await rows(p.id)).toHaveLength(2);
  active.embed.mockClear(); await edit(p.id,[C,A].join('\n\n')); await generation.embedPostContent(service.db,active,p.id); expect(active.embed.mock.calls[0][0]).toEqual(chunks.contentChunks(title,C));
  expect((await rows(p.id)).map((x:any)=>[x.text_hash,x.chunk_idx])).toEqual(chunks.contentChunks(title,[C,A].join('\n\n')).map((x:string,i:number)=>[hash(x),i]));
  active.embed.mockClear(); await edit(p.id,[C.toUpperCase(),A.toUpperCase()].join('\n\n')); await generation.embedPostContent(service.db,active,p.id); expect(active.embed).not.toHaveBeenCalled(); expect(await dirty(p.id)).toBe(false);
  await service.pool.query('UPDATE posts SET title=$1 WHERE id=$2',['Changed title',p.id]); await generation.embedPostContent(service.db,active,p.id); expect(active.embed.mock.calls[0][0]).toHaveLength(2);
  active={...provider(),model:'oracle-other'}; await generation.embedPostContent(service.db,active,p.id); expect((await rows(p.id)).every((x:any)=>x.model==='oracle-other')).toBe(true); expect(active.embed.mock.calls[0][0]).toHaveLength(2);
});
it.each(['draft','unlisted','deleted'])('collects %s vectors without a provider call', async status => {
  ready(); const p=await post(); await generation.embedPostContent(service.db,active,p.id); active.embed.mockClear(); await service.pool.query('UPDATE posts SET status=$1 WHERE id=$2',[status,p.id]);
  expect(await generation.embedPostContent(service.db,active,p.id)).toMatchObject({inserted:0,deleted:1}); expect(await rows(p.id)).toEqual([]); expect(active.embed).not.toHaveBeenCalled();
});
it('handles missing and zero-chunk bodies and preserves microsecond watermark precision', async () => {
  ready(); expect(await generation.embedPostContent(service.db,active,randomUUID())).toEqual({inserted:0,deleted:0,skipped:null});
  const p=await post(); await generation.embedPostContent(service.db,active,p.id); const stamp=(await service.pool.query('SELECT updated_at::text AS t, updated_at=content_embedded_at AS same FROM posts WHERE id=$1',[p.id])).rows[0]; expect(stamp.same).toBe(true);
  await generation.embedPostContent(service.db,active,p.id); expect((await service.pool.query('SELECT updated_at::text AS t FROM posts WHERE id=$1',[p.id])).rows[0].t).toBe(stamp.t);
  await edit(p.id,'<!--paywall-->'); await generation.embedPostContent(service.db,active,p.id); expect(await rows(p.id)).toEqual([]); expect(await dirty(p.id)).toBe(false);
});
it('keeps provider/database failures repairable and respects a denied budget', async () => {
  ready(); const p=await post(); active.embed.mockRejectedValueOnce(new Error('synthetic failure')); await generation.embedPostContent(service.db,active,p.id).catch(() => undefined); expect(await dirty(p.id)).toBe(true);
  active.embed.mockResolvedValueOnce([[1,0,0]]); await generation.embedPostContent(service.db,active,p.id).catch(() => undefined); expect(await rows(p.id)).toEqual([]);
  budget.mockResolvedValue(false); active.embed.mockClear(); expect((await generation.embedPostContent(service.db,active,p.id)).skipped).toBe('budget'); expect(active.embed).not.toHaveBeenCalled(); expect(await dirty(p.id)).toBe(true);
  budget.mockResolvedValue(true); await generation.embedPostContent(service.db,active,p.id); expect(await dirty(p.id)).toBe(false);
});
it('releases the post lock while embedding and refuses stale results without hiding unfinished work', async () => {
  ready(); const p=await post(A); const entered=deferred<void>(), done=deferred<number[][]>();
  const job=generation.embedPostContent(service.db,{model:active.model,embed:async()=>{entered.resolve();return done.promise;}},p.id);
  await entered.promise; const client=await service.pool.connect();
  try { await client.query("SET statement_timeout='2s'"); await client.query('UPDATE posts SET body_md=$1 WHERE id=$2',[B,p.id]); } finally { client.release(); done.resolve([vector()]); }
  await job; expect(await rows(p.id)).toEqual([]); expect(await dirty(p.id)).toBe(true);
  await generation.embedPostContent(service.db,active,p.id); expect((await rows(p.id))[0].text_hash).toBe(hash(chunks.contentChunks(title,B)[0])); expect(await dirty(p.id)).toBe(false);
});
it('a later completion wins without the older completion deleting or resurrecting vectors', async () => {
  ready(); const p=await post(A); const entered=deferred<void>(), done=deferred<number[][]>(); const old=generation.embedPostContent(service.db,{model:active.model,embed:async()=>{entered.resolve();return done.promise;}},p.id);
  await entered.promise; try { await edit(p.id,C); await generation.embedPostContent(service.db,active,p.id); } finally { done.resolve([vector(3)]); }
  await old; expect((await rows(p.id)).map((x:any)=>x.text_hash)).toEqual([hash(chunks.contentChunks(title,C)[0])]); expect(await dirty(p.id)).toBe(false);
});
it('an older editing transaction still leaves a newly edited body dirty', async () => {
  ready(); const p=await post(); const client=await service.pool.connect();
  try { await client.query('BEGIN'); await client.query('SELECT now()'); await generation.embedPostContent(service.db,active,p.id); await client.query('UPDATE posts SET body_md=$1 WHERE id=$2',[B,p.id]); await client.query('COMMIT'); expect(await dirty(p.id)).toBe(true); } finally { await client.query('ROLLBACK'); client.release(); }
});
it('scheduling is deferred and admits only source writes or transitions into discoverability', async () => {
  ready(); const p=await post();
  for(const input of [{status:'published',bodyWritten:true},{status:'published',previousStatus:'draft',bodyWritten:false},{status:'published',previousStatus:'unlisted',bodyWritten:false}]) scheduling.scheduleContentEmbedding({postId:p.id,...input});
  expect(pending).toHaveLength(3); expect(active.embed).not.toHaveBeenCalled();
  for(const input of [{status:'published',previousStatus:'published',bodyWritten:false},{status:'draft',bodyWritten:true},{status:'unlisted',bodyWritten:true},{status:'deleted',bodyWritten:true}]) scheduling.scheduleContentEmbedding({postId:p.id,...input});
  expect(pending).toHaveLength(3); for(const task of pending.splice(0)) await task(); expect(active.embed).toHaveBeenCalledTimes(1);
  active=null; scheduling.scheduleContentEmbedding({postId:p.id,status:'published',bodyWritten:true}); expect(pending).toEqual([]);
});
it('actual create and edit routes schedule content off-response, including a status-only publish', async () => {
  ready(); const owner=await fixtures.makeCreator(service,{handle:'prior-writer'});address=owner.walletAddress;
  const request=(path:string,method:string,body:any)=>new Request('https://fictional.example'+path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const created=await routes.create(request('/api/posts','POST',{title,bodyMd:A,status:'draft',price:'0',handle:'prior-writer'})); expect(created.status).toBe(201); const p=await created.json(); expect(p.status).toBe('draft'); for(const task of pending.splice(0)) await task(); expect(active.embed).not.toHaveBeenCalled(); expect(await rows(p.id)).toEqual([]);
  const publish=await routes.update(request('/api/posts/'+p.id,'PUT',{status:'published'})); expect(publish.status).toBe(200); expect(active.embed).not.toHaveBeenCalled(); expect(pending.length).toBeGreaterThan(0);
  for(const task of pending.splice(0)) await task(); expect(await rows(p.id)).toHaveLength(1);
  active.embed.mockClear(); const metadata=await routes.update(request('/api/posts/'+p.id,'PUT',{tags:['optics']}));expect(metadata.status).toBe(200);for(const task of pending.splice(0)) await task();expect(active.embed).not.toHaveBeenCalled();
  for(const patch of [{title:'Revised optical record'},{bodyMd:B}]) { const response=await routes.update(request('/api/posts/'+p.id,'PUT',patch));expect(response.status).toBe(200);expect(active.embed).not.toHaveBeenCalled();for(const task of pending.splice(0))await task();expect(active.embed).toHaveBeenCalledTimes(1);active.embed.mockClear(); }
  const response=await routes.create(request('/api/posts','POST',{title:'Published optical record',bodyMd:C,price:'0',handle:'prior-writer'}));expect(response.status).toBe(201);expect(active.embed).not.toHaveBeenCalled();active.embed.mockRejectedValueOnce(new Error('synthetic background failure'));for(const task of pending.splice(0))await task();expect(response.status).toBe(201);
  expect(JSON.stringify(await publish.json())).not.toMatch(/contentEmbeddedAt|content_embedded_at|embedding/);
  const invalid=await routes.update(request('/api/posts/'+p.id,'PUT',{status:'invalid'}));expect(invalid.status).toBe(400); active.embed.mockClear(); for(const task of pending.splice(0))await task(); expect(active.embed).not.toHaveBeenCalled();
});
it('sweep admits cardless live posts, excludes ineligible creators/posts and drains bounded batches', async () => {
  ready(); const owner=await fixtures.makeCreator(service);for(let i=0;i<102;i++)await post(A,'published',owner);
  for(const status of ['draft','unlisted','deleted'])await post(A,status,owner);const deleted=await fixtures.makeCreator(service);await post(A,'published',deleted);await service.pool.query('UPDATE creators SET deleted_at=now() WHERE id=$1',[deleted.id]);
  expect((await sweep.runEmbeddingsSweep(service.db,active)).contentScanned).toBe(100);expect((await sweep.runEmbeddingsSweep(service.db,active)).contentScanned).toBe(2);expect((await sweep.runEmbeddingsSweep(service.db,active)).contentScanned).toBe(0);expect(active.embed).toHaveBeenCalledTimes(102);
},60000);
it('sweep preserves its no-provider contract and collects orphan vectors even when generation budget is exhausted', async () => {
  ready(); const old=await post();await generation.embedPostContent(service.db,active,old.id);await service.pool.query("UPDATE posts SET status='unlisted' WHERE id=$1",[old.id]);const fresh=await post();
  expect((await sweep.runEmbeddingsSweep(service.db,null)).skipped).toBe('no-provider');expect(await rows(old.id)).toHaveLength(1);
  budget.mockResolvedValue(false);const result=await sweep.runEmbeddingsSweep(service.db,active);expect(result.budgetExhausted).toBe(true);expect(result.contentScanned).toBe(1);expect(result.contentGcOrphaned).toBe(1);expect(await rows(old.id)).toEqual([]);expect(await dirty(fresh.id)).toBe(true);
});
it('sweep caps orphan post identities at 500 while collecting all vectors belonging to an admitted orphan', async () => {
  ready(); const owner=await fixtures.makeCreator(service);const orphans=[];for(let i=0;i<501;i++)orphans.push(await post(A,'unlisted',owner));
  for(const p of orphans)await service.db.insert(schema.contentEmbeddings).values({postId:p.id,chunkIdx:0,source:'body',textHash:randomUUID(),model:active.model,embedding:vector()});
  expect((await sweep.runEmbeddingsSweep(service.db,active)).contentGcOrphaned).toBe(500);expect((await sweep.runEmbeddingsSweep(service.db,active)).contentGcOrphaned).toBe(1);
  const many=orphans[0];await service.db.insert(schema.contentEmbeddings).values(Array.from({length:501},(_,i)=>({postId:many.id,chunkIdx:i,source:'body',textHash:randomUUID(),model:active.model,embedding:vector()})));expect((await sweep.runEmbeddingsSweep(service.db,active)).contentGcOrphaned).toBe(501);
},60000);
it('body vectors remain dark in the historical retrieval stage', async () => {
  ready();const retrieval=await import('../lib/search/retrieve/candidates');const p=await post();await service.db.insert(schema.resourceMetadata).values({postId:p.id,cacheEligible:true,questionsAnswered:['unrelated mechanical question'],scope:'unrelated mechanics'});
  await generation.embedPostContent(service.db,active,p.id);expect(await retrieval.denseLookup(service.db,{question:'zircon observatory',limit:10},vector())).toEqual([]);
});

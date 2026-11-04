import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cliArguments, models, requestInput, runStep, streamStep } from './bridge.js'
import { parseResponse } from './protocol.js'

const request = { model: 'default', maxTokens: 128, messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] }
const tools = [{ name: 'calculate', description: 'Calculate a value', parameters: {
  type: 'object', properties: { x: { type: 'number' } }, required: ['x'],
} }]

// A real subprocess/socket peer exercises framing, CLI arguments, exports,
// expected handoffs, failure paths and process cancellation without model calls.
async function fakeVibe(mode, run) {
  const directory = await mkdtemp(join(tmpdir(), 'fake vibe with spaces '))
  const executable = join(directory, 'vibe')
  const source = `#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {join} from 'node:path';
const mode=${JSON.stringify(mode)};
const args=process.argv.slice(2);
const arg=name=>args[args.indexOf(name)+1];
assert.ok(args.includes('--yolo'));
assert.equal(arg('--disabled-tools'),'*');
assert.equal(arg('--max-turns'),'1');
assert.ok(!args.includes('--model'),'default must use Vibe config');
assert.equal(process.env.VIBE_AGENT_MAX_OUTPUT_TOKENS,'128');
const out=arg('--output-dir');
await mkdir(out,{recursive:true});
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const exportResult=async(outcome,code,error)=>{
  await writeFile(join(out,'export.json'),JSON.stringify({outcome,error,
    usage:{input_tokens:10,output_tokens:2,cached_input_tokens:3,total_tokens:12}}));
  process.exitCode=code;
};
if(mode==='hang'){setInterval(()=>{},1000);}
else if(mode==='failure'){await exportResult('infrastructure_failure',2,{message:'test authentication failure'});}
else if(mode==='missing-export'){process.exitCode=1;}
else if(['tool','unknown-tool','bad-protocol','bad-handoff'].includes(mode)){
  const call=(method,params)=>new Promise((resolve,reject)=>{
    const s=createConnection(arg('--agent-socket'));let data='';
    s.on('error',reject);s.setEncoding('utf8');
    s.on('connect',()=>{const line=JSON.stringify({jsonrpc:'2.0',id:1,method,params})+'\\n';s.write(line.slice(0,3));s.write(line.slice(3));});
    s.on('data',chunk=>{data+=chunk;if(data.includes('\\n')){resolve(JSON.parse(data.split('\\n')[0]));s.end();}});
  });
  const hello=await call('agent/initialize',{protocolVersion:mode==='bad-protocol'?999:2});
  if(mode!=='bad-protocol'){
    assert.equal(hello.result.tools[0].modelAccess,'direct');
    assert.equal(hello.result.tools[0].inputSchema.required[0],'x');
    assert.ok(hello.result.tools[0].name.startsWith('dsh_'),'avoid native Vibe tool-name conflicts');
    const toolName='dsh.'+hello.result.tools[0].name;
    const reply=await call('tools/call',{name:mode==='unknown-tool'?'vibe.bash':toolName,input:{x:7},toolCallId:'call-1'});
    assert.equal(reply.error.code,-32002);
    if(mode==='bad-handoff')await exportResult('finished',0);
    else await exportResult('aborted',4,{message:reply.error.message});
  }
}else if(mode==='recover-native'&&!prompt.includes('Bridge correction:')){
  await exportResult('turn_limit',3);
}else{
  const correction=prompt.includes('Bridge correction:');
  const needsTool=['json-tool','forged-tool','recover-native'].includes(mode)||(mode==='recover-progress'&&correction);
  const progress=mode==='stuck-progress'||(mode==='recover-progress'&&!correction);
  const reply=needsTool?{type:'tool_calls',calls:[{name:mode==='forged-tool'?'undeclared':'calculate',arguments:{x:7}}]}:
    {type:'final',status:'complete',text:progress?'Reading the security scan summary now':'VIBE_OK'};
  console.log(JSON.stringify({type:'message',role:'user',content:[{type:'text',text:'must not echo'}]}));
  console.log(JSON.stringify({type:'message',role:'assistant',generationStatus:'completed',content:[{type:'text',text:mode==='limited'?'VIBE_OK':JSON.stringify(reply)}]}));
  await exportResult(mode==='limited'?'length':'finished',mode==='limited'?3:0);
}
`
  await writeFile(executable, source, { mode: 0o700 })
  try { await run(executable) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('history preserves system instructions, tool call IDs and error results', () => {
  const result = requestInput({ messages: [
    { role: 'system', content: [{ type: 'text', text: 'Use DSH tools' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 'calculate', arguments: '{"x":7}' }] },
    { role: 'tool', toolCallId: 'c', isError: true, content: [{ type: 'text', text: 'failed' }] },
  ] })
  assert.match(result.system, /Use DSH tools/)
  const history = JSON.parse(result.prompt).conversation
  assert.equal(history[0].content[0].name, 'calculate')
  assert.equal(history[1].toolCallId, 'c')
  assert.equal(history[1].isError, true)
})

test('runtime context cannot replace the latest real user request', () => {
  const result = requestInput({ messages: [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Read summary.md' }] },
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context' }] },
  ] })
  const input = JSON.parse(result.prompt)
  assert.equal(input.latestUserRequest[0].text, 'Read summary.md')
  assert.equal(input.conversation[1].source, 'runtime-context')
  assert.match(result.system, /Do not copy their identity/)
})

test('JSON tool requests are real DSH calls, never displayed as final commentary', async () => {
  await fakeVibe('json-tool', async executable => {
    const result = await runStep({ ...request, tools }, executable)
    assert.equal(result.reason.kind, 'tool-calls')
    assert.equal(result.blocks[0].name, 'calculate')
    assert.equal(result.blocks[0].arguments, '{"x":7}')
  })
})

test('a native-tool denial or empty progress promise is corrected and its usage retained', async () => {
  for (const mode of ['recover-native', 'recover-progress']) await fakeVibe(mode, async executable => {
    const result = await runStep({ ...request, tools }, executable)
    assert.equal(result.reason.kind, 'tool-calls')
    assert.equal(result.blocks[0].name, 'calculate')
    assert.equal(result.usage.inputTokens, 14)
    assert.equal(result.usage.cacheReadTokens, 6)
  })
})

test('repeated fake progress or undeclared tools fail instead of pretending work started', async () => {
  for (const mode of ['stuck-progress', 'forged-tool']) await fakeVibe(mode, async executable => {
    await assert.rejects(runStep({ ...request, tools }, executable), /after correction/)
  })
  assert.throws(() => parseResponse('{"type":"tool_calls","calls":[{"name":"calculate","arguments":[]}]}', { tools }), /arguments/)
  assert.throws(() => parseResponse(JSON.stringify({ type: 'final', status: 'complete', text: 'I’m reading the summary now' }), { tools }), /announced an action/)
  assert.deepEqual(parseResponse('{"type":"final","status":"needs_input","text":"Which repository?"}', { tools }),
    [{ type: 'text', text: 'Which repository?' }])
})

test('CLI flags disable native tools and alias values stay separate argv entries', () => {
  const args = cliArguments({ model: 'alias with spaces' }, '/tmp/work', '/tmp/a.sock')
  assert.equal(args[args.indexOf('--disabled-tools') + 1], '*')
  assert.equal(args[args.indexOf('--model') + 1], 'alias with spaces')
  assert.deepEqual(models({ DSH_VIBE_MODELS: 'one,two,one' }).map(model => model.id), ['default', 'one', 'two'])
})

test('real child reply becomes DSH blocks, without echoing user input or double-counting cache', async () => {
  await fakeVibe('text', async executable => {
    const result = await runStep(request, executable)
    assert.deepEqual(result.blocks, [{ type: 'text', text: 'VIBE_OK' }])
    assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3, totalTokens: 12 })
    assert.equal(result.reason.kind, 'stop')
  })
})

test('socket tool call aborts Vibe and hands the exact arguments to DSH', async () => {
  await fakeVibe('tool', async executable => {
    const chunks = []
    for await (const chunk of streamStep({ ...request, tools }, executable)) chunks.push(chunk)
    assert.deepEqual(chunks.find(chunk => chunk.type === 'block-end').block,
      { type: 'tool-call', id: 'call-1', name: 'calculate', arguments: '{"x":7}' })
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  })
})

test('a DSH tool with a native Vibe name uses a distinct client alias', async () => {
  await fakeVibe('tool', async executable => {
    const result = await runStep({ ...request, tools: [{ ...tools[0], name: 'bash' }] }, executable)
    assert.equal(result.blocks[0].name, 'bash')
    assert.equal(result.reason.kind, 'tool-calls')
  })
})

test('unknown tools, protocol drift and unacknowledged handoffs fail closed', async () => {
  for (const mode of ['unknown-tool', 'bad-protocol', 'bad-handoff'])
    await fakeVibe(mode, async executable => {
      await assert.rejects(runStep({ ...request, tools }, executable), /Unsupported Vibe socket request|did not acknowledge/)
    })
})

test('nonzero failures and missing exports are reported', async () => {
  await fakeVibe('failure', async executable => {
    await assert.rejects(runStep(request, executable), /test authentication failure/)
  })
  await fakeVibe('missing-export', async executable => {
    await assert.rejects(runStep(request, executable), /no valid export/)
  })
  await assert.rejects(runStep(request, '/no/such/vibe-cli'), /ENOENT/)
})

test('output limits preserve the partial response and return max-tokens', async () => {
  await fakeVibe('limited', async executable => {
    const result = await runStep(request, executable)
    assert.equal(result.reason.kind, 'max-tokens')
    assert.equal(result.blocks[0].text, 'VIBE_OK')
  })
})

test('cancellation terminates and reaps the spawned CLI', async () => {
  await fakeVibe('hang', async executable => {
    const controller = new AbortController()
    const running = runStep({ ...request, signal: controller.signal }, executable)
    setTimeout(() => controller.abort(), 100)
    await assert.rejects(running, error => error.name === 'AbortError')
    await assert.rejects(runStep({ ...request, signal: controller.signal }, executable), error => error.name === 'AbortError')
  })
})

test('unsupported attachments and controls fail before starting a process', async () => {
  await assert.rejects(runStep({ ...request, messages: [{ role: 'user', content: [{ type: 'image' }] }] }), /image/)
  await assert.rejects(runStep({ ...request, temperature: 0.5 }), /temperature/)
})

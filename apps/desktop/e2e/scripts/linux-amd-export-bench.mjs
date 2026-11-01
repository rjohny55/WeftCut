// Opt-in export benchmark. Use a fresh app profile and the synthetic fixture;
// this never opens an arbitrary user project or publishes credentials/logs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const match = /^--(auth|project|route|samples|out)=(.+)$/.exec(value);
  if (!match) throw Error('Expected --auth=FILE --project=DIR --route=cpu|native|bridge --out=DIR [--samples=5]');
  return [match[1], match[2]];
}));
const samples = Number(args.samples ?? 5);
if (!args.auth || !args.project || !args.out || !['cpu', 'native', 'bridge'].includes(args.route)
  || !Number.isInteger(samples) || samples < 1 || samples > 20) throw Error('Invalid benchmark arguments');
const project = path.resolve(args.project);
const fixture = JSON.parse(await fs.readFile(path.join(project, 'project.json'), 'utf8'));
if (fixture.metadata?.name !== 'Linux AMD export benchmark' || Object.keys(fixture.media_pool ?? {}).length)
  throw Error('Only the bundled synthetic Linux AMD export fixture is accepted');
const auth = JSON.parse(await fs.readFile(args.auth, 'utf8'));
if (!Number.isInteger(auth.port) || auth.port < 1 || auth.port > 65535 || typeof auth.token !== 'string')
  throw Error('Invalid local MCP connection');
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${auth.port}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${auth.token}` } },
});
const client = new Client({ name: 'linux-amd-export-benchmark', version: '1.0.0' });
const call = async (name, input = {}) => {
  const result = await client.callTool({ name, arguments: input }, undefined, { timeout: 180000 });
  if (result.isError) throw Error(`Benchmark MCP operation failed: ${name}`);
  return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
};
const report = { route: args.route, scope: '1080p30, 120 frames, SDR8 H.264, 8 Mbps VBR, no audio',
  timing: 'MCP start_export to observed completed; 100 ms polling; one excluded warm-up',
  actualRoute: 'Verify the application log; a requested route is not evidence of selection.', samples: [] };
await fs.mkdir(args.out, { recursive: true });
const output = await fs.mkdtemp(path.join(path.resolve(args.out), `${args.route}-`));
try {
  await client.connect(transport);
  await call('open_project', { path: project });
  const defaults = (await call('get_export_options')).settings;
  for (let sample = 0; sample <= samples; sample++) {
    const began = performance.now();
    const job = await call('start_export', { request_id: randomUUID(), on_conflict: 'fail',
      output_path: path.join(output, `${sample}.mp4`), range: { start_us: 0, end_us: 4000000 }, settings: {
        ...defaults, include_video: true, include_audio: false,
        audio: { ...defaults.audio, include: false }, resolution_height: null, fps: null,
        codec: 'h264', container: 'mp4', quality: 'custom', custom_bitrate: 8000000,
        rate_mode: 'vbr', crf: null, max_bitrate: null, buffer_size: null, preset: 'medium',
        hw_accel: args.route === 'cpu' ? 'software' : 'auto', encoder_engine: 'native',
        decode_engine: 'ffmpeg', bit_depth: 8, keyframe_interval_sec: 1,
      } });
    const deadline = performance.now() + 600000;
    for (;;) {
      if (performance.now() > deadline) {
        await call('cancel_export', { job_id: job.job_id });
        throw Error('Export exceeded the ten-minute sample deadline');
      }
      const status = await call('get_export_status', { job_id: job.job_id });
      if (['failed', 'cancelled', 'awaiting_retry'].includes(status.state)) throw Error(`Export ${status.state}`);
      if (status.state === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const row = { sample, warmup: sample === 0, wallMs: performance.now() - began };
    report.samples.push(row);
    console.log(JSON.stringify(row));
  }
  const warm = report.samples.filter(row => !row.warmup).map(row => row.wallMs).sort((a, b) => a - b);
  report.summary = { medianMs: warm[Math.floor(warm.length / 2)], minMs: warm[0], maxMs: warm.at(-1) };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
} finally {
  await transport.terminateSession().catch(() => {});
  await client.close();
}

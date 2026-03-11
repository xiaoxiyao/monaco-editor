import { run } from '../../scripts/lib/index';

export async function buildAmdMinDev() {
	const rootPath = __dirname;
	// 不构建dev版本，减少包体积
	// await run('npx vite build --mode development', { cwd: rootPath });
	await run('npx vite build', { cwd: rootPath });
	await run('npx rollup -c rollup-types.config.mjs', { cwd: rootPath });
}

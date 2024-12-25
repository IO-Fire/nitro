import { existsSync, promises as fsp } from "node:fs";
import { parseTOML, stringifyTOML } from "confbox";
import defu from "defu";
import { globby } from "globby";
import type { Nitro, NitroRouteRules } from "nitropack/types";
import { join, resolve } from "pathe";
import { isCI } from "std-env";
import {
  joinURL,
  hasProtocol,
  withLeadingSlash,
  withTrailingSlash,
  withoutLeadingSlash,
} from "ufo";
import type { CloudflarePagesRoutes } from "./types";

export async function writeCFPagesFiles(nitro: Nitro) {
  await writeCFRoutes(nitro);
  await writeCFPagesHeaders(nitro);
  await writeCFPagesRedirects(nitro);
  await writeCFWrangler(nitro);
}

export async function writeCFPagesStaticFiles(nitro: Nitro) {
  await writeCFPagesHeaders(nitro);
  await writeCFPagesRedirects(nitro);
}

async function writeCFRoutes(nitro: Nitro) {
  const _cfPagesConfig = nitro.options.cloudflare?.pages || {};
  const routes: CloudflarePagesRoutes = {
    version: _cfPagesConfig.routes?.version || 1,
    include: _cfPagesConfig.routes?.include || ["/*"],
    exclude: _cfPagesConfig.routes?.exclude || [],
  };

  const writeRoutes = () =>
    fsp.writeFile(
      resolve(nitro.options.output.dir, "_routes.json"),
      JSON.stringify(routes, undefined, 2)
    );

  if (_cfPagesConfig.defaultRoutes === false) {
    await writeRoutes();
    return;
  }

  // Exclude public assets from hitting the worker
  const explicitPublicAssets = nitro.options.publicAssets.filter(
    (dir, index, array) => {
      if (dir.fallthrough || !dir.baseURL) {
        return false;
      }

      const normalizedBase = withoutLeadingSlash(dir.baseURL);

      return !array.some(
        (otherDir, otherIndex) =>
          otherIndex !== index &&
          normalizedBase.startsWith(
            withoutLeadingSlash(withTrailingSlash(otherDir.baseURL))
          )
      );
    }
  );

  // Explicit prefixes
  routes.exclude!.push(
    ...explicitPublicAssets
      .map((asset) => joinURL(nitro.options.baseURL, asset.baseURL || "/", "*"))
      .sort(comparePaths)
  );

  // Unprefixed assets
  const publicAssetFiles = await globby("**", {
    cwd: nitro.options.output.dir,
    absolute: false,
    dot: true,
    ignore: [
      "_worker.js",
      "_worker.js.map",
      "nitro.json",
      ...routes.exclude!.map((path) =>
        withoutLeadingSlash(path.replace(/\/\*$/, "/**"))
      ),
    ],
  });
  // Remove index.html or the .html extension to support pages pre-rendering
  routes.exclude!.push(
    ...publicAssetFiles
      .map(
        (i) =>
          withLeadingSlash(i)
            .replace(/\/index\.html$/, "")
            .replace(/\.html$/, "") || "/"
      )
      .sort(comparePaths)
  );

  // Only allow 100 rules in total (include + exclude)
  routes.exclude!.splice(100 - routes.include!.length);

  await writeRoutes();
}

function comparePaths(a: string, b: string) {
  return a.split("/").length - b.split("/").length || a.localeCompare(b);
}

/**
 * Write the `_headers` file for Cloudflare Pages
 * @param nitro Nitro instance
 * @returns void
 */
async function writeCFPagesHeaders(nitro: Nitro) {
  // TODO: Warn that the functions dir is ignored when _worker.js is present e.g. SSR
  const cleanupHeaderWorkers = cleanupCFPagesHeaderWorkers(nitro);

  const headersPath = join(nitro.options.output.dir, "_headers");

  let totalExistingRules = 0;

  // TODO: Determine if can placed inside of the following if block
  // by removing fallback rule functionality
  let currentHeaders = "";

  if (existsSync(headersPath)) {
    // Read the current headers file
    currentHeaders = await fsp.readFile(headersPath, "utf8");

    // Count the number of existing header rules
    totalExistingRules = countCFPagesHeaderRules(currentHeaders);

    // TODO: Determine purpose of the following code block
    if (/^\/\* /m.test(currentHeaders)) {
      nitro.logger.info(
        "Not adding Nitro fallback to `_headers` (as an existing fallback was found)."
      );

      // TODO: Determine if the fallback rule functionality should be removed
      return;
    }
  }

  // Create a new array to store the new header file contents
  const newHeaderFileContents: string[] = [];

  // Sort the rules by the number of path segments
  const newRules = Object.entries(nitro.options.routeRules).sort(
    (a, b) => b[0].split(/\/(?!\*)/).length - a[0].split(/\/(?!\*)/).length
  );

  // Calculate the total number of rules
  const totalRules = newRules.length + totalExistingRules;

  // Check for the 100 rule limit
  if (totalRules >= 100) {
    // If the total number of rules exceeds 100, split the rules into header rules and worker rules

    nitro.logger.warn(
      "The Cloudflare Pages headers file only supports up to `100` rules.\nThe remaining header rules will be handled by Cloudflare Workers."
    );

    nitro.logger.debug(`Existing headers rules: \`${totalExistingRules}\``);

    nitro.logger.debug(`New headers rules: \`${newRules.length}\``);

    // Split the rules into header file rules and worker rules
    // TODO: WorkersHeaders implementation does not support wildcard or placeholders yet. The split should be based on the rule type.
    const wildcardRules: typeof newRules = [];
    const otherRules: typeof newRules = [];

    // Split the rules into wildcard rules and other rules
    for (const rule of newRules) {
      // Check if the rule has wildcards
      if (rule[0].includes("/*")) {
        wildcardRules.push(rule);
      } else {
        otherRules.push(rule);
      }
    }

    // Combine wildcard rules with other rules, ensuring the total does not exceed 100
    const headerRules = [
      ...wildcardRules,
      ...otherRules.slice(0, 100 - totalExistingRules - wildcardRules.length),
    ];

    // Remaining rules that exceed the 100 limit will be handled by workers
    // Worker rules are the rules that will be handled by workers
    const workerRules = otherRules.slice(
      100 - totalExistingRules - wildcardRules.length
    );

    // Wait for the cleanup to finish
    await cleanupHeaderWorkers;

    // start writing workers
    const workers = writeCFPagesHeaderWorkers(nitro, workerRules);

    // generate header rules for the first 100 rules
    // for the header file, the 100 rule limit is enforced
    // contents is modified by reference
    generateCFHeaderRuleLines(nitro, newHeaderFileContents, headerRules);

    // apply fallback rule if it doesn't exist
    // TODO: Determine if the fallback rule functionality should be removed
    applyCFPagesHeaderFallbackRule(
      nitro,
      newHeaderFileContents,
      currentHeaders
    );

    // start writing the headers file
    const headers = writeCFPagesHeadersFile(newHeaderFileContents, headersPath);

    // wait for workers and headers to finish
    await workers;
    await headers;
  } else {
    // generate header rules for all rules
    generateCFHeaderRuleLines(nitro, newHeaderFileContents, newRules);

    // apply fallback rule if it doesn't exist
    // TODO: Determine if the fallback rule functionality should be removed
    applyCFPagesHeaderFallbackRule(
      nitro,
      newHeaderFileContents,
      currentHeaders
    );

    // Wait for the cleanup to finish
    await cleanupHeaderWorkers;

    // write the headers file
    await writeCFPagesHeadersFile(newHeaderFileContents, headersPath);
  }
}

async function writeCFPagesHeadersFile(
  contents: string[],
  headersPath: string
) {
  return fsp.writeFile(headersPath, contents.join("\n"));
}

/**
 * Apply the fallback rule to the `_headers` file
 * @param nitro Nitro instance
 * @param contents Array of lines representing the headers file
 */
function applyCFPagesHeaderFallbackRule(
  nitro: Nitro,
  contents: string[],
  currentHeaders: string
) {
  nitro.logger.info(
    "Adding Nitro fallback to `_headers` to handle all unmatched routes."
  );
  contents.unshift(currentHeaders);
}

/**
 * Generate the header rule lines for the `_headers` file
 * @param newContents Array of lines representing the headers file
 * @param rules Array of NitroRouteRules to generate header rules for
 * @returns void, newContents is modified by reference
 */
function generateCFHeaderRuleLines(
  nitro: Nitro,
  newContents: string[],
  rules: [path: string, routeRules: NitroRouteRules][]
) {
  for (const [path, routeRules] of rules.filter(
    ([_, routeRules]) => routeRules.headers
  )) {
    const headers = [
      joinURL(nitro.options.baseURL, path.replace("/**", "/*")),
      ...Object.entries({ ...routeRules.headers }).map(
        ([header, value]) => `  ${header}: ${value}`
      ),
    ].join("\n");

    newContents.push(headers);
  }
}

/**
 *
 * @param headersFileArray Array of lines representing the headers file
 * @returns Number of header rules
 *
 * @example ```plaintext
 * Line 0:/fruit/*
 * Line 1:  Cache-Control: max-age=3600
 * Line 2:  X-Frame-Options: DENY
 * Line 3:
 * Line 4:/vegetable/carrot
 * Line 5:  Cache-Control: max-age=3600
 * ```
 * **Returns**: `2` (2 rules: `/fruit/*` and `/vegetable/carrot`)
 *
 * Line: 0, 4 are header rules, 1, 2, 5 are headers, 3 is an empty line
 */
function countCFPagesHeaderRules(headersFileContents: string): number {
  // This function omits the full parsing of the headers file for performance reasons.
  // Only count is used to determine if the headers file should be split into a workers.
  // The individual header character length of 2000 is also not tested.
  return (headersFileContents.match(/^\/|https:\/\//gm) || []).length;
}

/**
 * Creates proxy workers for headers that exceed the 100 rule limit
 * @param nitro Nitro instance
 * @param rules Array of NitroRouteRules to generate worker rules for
 */
async function writeCFPagesHeaderWorkers(
  nitro: Nitro,
  rules: [path: string, NitroRouteRules][]
) {
  // The generated workers will be placed in the functions directory in the project

  // Create the workers directory
  // TODO: Find better way to get the workers directory
  const workersDir = join(nitro.options.output.dir, "../functions");

  // Create the workers directory if it doesn't exist
  const statWorkerDir = await fsp.stat(workersDir).catch(() => null);
  if (statWorkerDir && !statWorkerDir.isDirectory()) {
    nitro.logger.error(
      `Expected ${workersDir} to be a directory or not exist.`
    );
  } else {
    nitro.logger.debug("Creating workers directory.");
    await fsp.mkdir(workersDir, { recursive: true });
  }

  // Create an array of promises to write the workers
  const workers: Promise<void>[] = [];
  const workerFilePaths: string[] = [];

  // Write the workers for each rule
  for (const [path, routeRules] of rules.filter(
    ([_, routeRules]) => routeRules.headers
  )) {
    // Get the slug for the worker file
    const isIndex = path.endsWith("/");
    const slug = isIndex
      ? "index"
      : // If the status code path is used, use the status code as the slug
        (path === "/200.html"
          ? "200"
          : // If the status code path is used, use the status code as the slug

            // unicorn/no-nested-ternary clashes with prettier
            // eslint-disable-next-line unicorn/no-nested-ternary
            path === "/404.html"
            ? "404"
            : // Get the slug from the path
              // `/path/to/file` -> `file`
              path.split("/").at(-1)) || "";

    // Create the worker file directory
    const workerFileDir = joinURL(
      workersDir,
      nitro.options.baseURL,
      isIndex ? path : path.slice(0, path.lastIndexOf("/") + 1)
    );

    // Create the worker file path
    const workerFilePath = `${joinURL(workerFileDir, slug)}.js`;
    workerFilePaths.push(workerFilePath);

    // Create the headers array text
    let headersArrayText = "";

    // Create the headers array
    const headersLength = Object.entries({ ...routeRules.headers }).map(
      ([header, value], index) => {
        // add separator if not first header
        if (index !== 0) {
          headersArrayText += ",";
        }

        // build the headers array string
        // use the format: ["header","value"]
        headersArrayText += `${JSON.stringify(header)},${JSON.stringify(value)}`;
      }
    ).length;

    /**
     * Create the worker content
     * @example ```javascript
     * export async function onRequest(c){
     *  var r=await c.next();
     *  var h=["header1","value1","header2","value2"];
     *  for(let i = 0; i < 4;i += 2){
     *   r.headers.set(h[i],h[i+1])
     *  }
     *  return r
     * }
     * ```
     *
     * The worker proxies the request with headers set based on the route rules.
     * The code has been minified to reduce the cold start time of the worker.
     *
     *
     * By reducing the file size, the worker can start up faster, improving performance.
     *   The worker content is a function that takes a `c` (`context`) parameter and returns a `Response` object.
     *   Calls the `next` method on the context object to get the upstream response object.
     *   The upstream response object is stored in the `r` (`response`) variable.
     *   The function sets the headers for the response object based on the headers array.
     *   The headers array is an array of strings in the format: `["header","value","header","value"]`.
     *   The function loops through the headers array and sets the headers for the response object.
     *   The function returns the response object.
     *
     * Results in the following output:
     * ```javascript
     * Response {
     * headers: Headers {
     * map: {
     * header1: 'value1',
     * header2: 'value2',
     * content-type: 'text/html; charset=utf-8',
     * // The worker may override the content-type header
     * }
     * },
     * status: 200,
     * statusText: 'OK',
     * body: '<html>...</html>',
     * }
     */
    const workerContent = `/*NITRO_GEN*/export async function onRequest(c){var r=await c.next();var h=[${headersArrayText}];for(let i=0;i<${headersLength * 2};i+=2){r.headers.set(h[i],h[i+1])}return r}`;

    const w = new Promise<void>((resolve, reject) => {
      // Create the workers file directory if it doesn't exist
      if (existsSync(workerFileDir)) {
        // Write the content to the new JavaScript file
        fsp
          .writeFile(workerFilePath, workerContent)
          .then(() => resolve())
          .catch((error) => reject(error));
      } else {
        fsp
          .mkdir(workerFileDir, { recursive: true })
          .then(() => {
            // Check that file does not already exist
            // Prevent overwriting user generated files
            fsp
              .stat(workerFilePath)
              .then(() =>
                reject(
                  `The file already exists for the headers worker to be created: ${workerFilePath}`
                )
              )
              .catch(() => {
                // Write the content to the new JavaScript file
                fsp
                  .writeFile(workerFilePath, workerContent)
                  .then(() => resolve())
                  .catch((error) => reject(error));
              });
          })
          .catch((error) => reject(error));
      }
    });

    workers.push(w);
  }

  try {
    // Wait for all workers to finish writing
    await Promise.all(workers);
    nitro.logger.info(`Created \`${workers.length}\` header workers.`);

    // Git ignore the generated workers
    const gitIgnorePath = join(workersDir, ".gitignore");
    const gitIgnoreContent = workerFilePaths
      .map((path) => path.replace(workersDir, ""))
      .join("\n");
    await fsp.appendFile(gitIgnorePath, gitIgnoreContent);
  } catch (error) {
    // Log any errors
    nitro.logger.error("Error writing CF Pages header workers:", error);
    // Re-throw the error
    throw error;
  }
}

async function cleanupCFPagesHeaderWorkers(nitro: Nitro) {
  // The generated workers will be placed in the functions directory in the project

  // Find all workers
  // TODO: Find better way to get the workers directory
  const workersDir = join(nitro.options.output.dir, "../functions");

  // Check if the workers directory exists
  const statWorkerDir = await fsp.stat(workersDir).catch(() => null);
  if (statWorkerDir !== null && !statWorkerDir.isDirectory()) {
    nitro.logger.error(
      `Expected ${workersDir} to be a directory or not exist.`
    );
    return;
  }

  /**
   * Array of promises to inspect workers
   * Paths represent the header worker file paths
   * @type {Promise<void | string>[]}
   * @description Array of promises to inspect workers
   * @example Promise [null, "path/to/worker.js", null]
   */
  const allWorkers: Promise<void | string>[] = [];

  // Find all worker files
  const workerFilePaths = await globby(join(workersDir, "**/*.js"));
  for (const workerFilePath of workerFilePaths) {
    const w = new Promise<void | string>((resolve, reject) => {
      fsp
        .readFile(workerFilePath, "utf8")
        .then((workerContent) => {
          if (workerContent.startsWith("/*NITRO_GEN*/")) {
            resolve(workerFilePath);
          } else {
            // Not a generated worker
            resolve();
          }
        })
        .catch((error) => reject(error));
    });
    allWorkers.push(w);
  }

  // Wait for all workers to finish
  await Promise.all(allWorkers);

  // Remove the worker files
  const removedWorkers: Promise<void>[] = [];
  for (const workerFilePath of workerFilePaths) {
    // Remove worker task
    const w = new Promise<void>((resolve, reject) => {
      fsp
        .unlink(workerFilePath)
        .then(() => {
          nitro.logger.debug(
            `Removed old header worker file: ${workerFilePath}`
          );
          resolve();
        })
        .catch((error) => reject(error));
    });

    // Add the worker task to be awaited
    removedWorkers.push(w);
  }

  // Remove the header workers from .gitignore
  const gitIgnorePath = join(workersDir, ".gitignore");

  // Check if the gitignore file exists
  if (!existsSync(gitIgnorePath)) {
    // Wait for all headers workers to be removed
    await Promise.all(removedWorkers);
    nitro.logger.debug("Removed all old header workers.");
    return;
  }

  // Read the gitignore file
  const gitIgnore = fsp
    .readFile(gitIgnorePath, "utf8")
    .then((gitIgnoreContent) => {
      const newGitIgnoreContent = gitIgnoreContent
        .split("\n")
        .filter((line) => !workerFilePaths.includes(join(workersDir, line)))
        .join("\n");

      return fsp.writeFile(gitIgnorePath, newGitIgnoreContent);
    });

  // Wait for all headers workers to be removed
  await Promise.all(removedWorkers);
  nitro.logger.debug("Removed all old header workers.");

  // Wait for the gitignore to be updated
  await gitIgnore;

  return;
}

async function writeCFPagesRedirects(nitro: Nitro) {
  const redirectsPath = join(nitro.options.output.dir, "_redirects");
  const staticFallback = existsSync(
    join(nitro.options.output.publicDir, "404.html")
  )
    ? `${joinURL(nitro.options.baseURL, "/*")} ${joinURL(nitro.options.baseURL, "/404.html")} 404`
    : "";
  const contents = [staticFallback];
  const rules = Object.entries(nitro.options.routeRules).sort(
    (a, b) => a[0].split(/\/(?!\*)/).length - b[0].split(/\/(?!\*)/).length
  );

  for (const [key, routeRules] of rules.filter(
    ([_, routeRules]) => routeRules.redirect
  )) {
    const code = routeRules.redirect!.statusCode;
    const from = joinURL(nitro.options.baseURL, key.replace("/**", "/*"));
    const to = hasProtocol(routeRules.redirect!.to, { acceptRelative: true })
      ? routeRules.redirect!.to
      : joinURL(nitro.options.baseURL, routeRules.redirect!.to);
    contents.unshift(`${from}\t${to}\t${code}`);
  }

  if (existsSync(redirectsPath)) {
    const currentRedirects = await fsp.readFile(redirectsPath, "utf8");
    if (/^\/\* /m.test(currentRedirects)) {
      nitro.logger.info(
        "Not adding Nitro fallback to `_redirects` (as an existing fallback was found)."
      );
      return;
    }
    nitro.logger.info(
      "Adding Nitro fallback to `_redirects` to handle all unmatched routes."
    );
    contents.unshift(currentRedirects);
  }

  await fsp.writeFile(redirectsPath, contents.join("\n"));
}

async function writeCFWrangler(nitro: Nitro) {
  type WranglerConfig = typeof nitro.options.cloudflare.wrangler;

  const inlineConfig: WranglerConfig =
    nitro.options.cloudflare?.wrangler || ({} as WranglerConfig);

  // Write wrangler.toml only if config is not empty
  if (!inlineConfig || Object.keys(inlineConfig).length === 0) {
    return;
  }

  let configFromFile: WranglerConfig = {} as WranglerConfig;
  const configPath = resolve(
    nitro.options.rootDir,
    inlineConfig.configPath || "wrangler.toml"
  );
  if (existsSync(configPath)) {
    configFromFile = parseTOML<WranglerConfig>(
      await fsp.readFile(configPath, "utf8")
    );
  }

  const wranglerConfig: WranglerConfig = defu(configFromFile, inlineConfig);

  const wranglerPath = join(
    isCI ? nitro.options.rootDir : nitro.options.buildDir,
    "wrangler.toml"
  );

  await fsp.writeFile(wranglerPath, stringifyTOML(wranglerConfig));
}

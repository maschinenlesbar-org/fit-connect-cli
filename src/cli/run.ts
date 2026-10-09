// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import { logOf, type CliDeps } from "./io.js";
import { DEFAULT_LOG_FORMAT, createLogger, logFormatFromArgv, type LogFormat, type Logger } from "./log.js";
import {
  FitConnectApiError,
  FitConnectError,
  FitConnectNetworkError,
  FitConnectParseError,
  FitConnectValidationError,
  credentialsIn,
  echoedCredentialForms,
  redactCredentials,
  redactSecrets,
} from "../client/errors.js";

/** Exit code of a run without its command, and of `help` for an unknown command. */
const USAGE_EXIT = 1;

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps, state: { errorLogged: boolean } = { errorLogged: false }): void {
  command.exitOverride();
  // Propagate showHelpAfterError to every subcommand so parse errors render the
  // same depth of help everywhere, not just at the root.
  command.showHelpAfterError();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => writeCommanderErr(command, deps, state, str),
  });
  if (command.commands.length > 0) addHelpCommand(command);
  for (const child of command.commands) configureTree(child, deps, state);
}

/** `fit-connect routes`: the command's name with its parents'. */
function commandPath(command: Command): string {
  const names: string[] = [];
  for (let c: Command | null = command; c !== null; c = c.parent) names.unshift(c.name());
  return names.join(" ");
}

/**
 * commander's stderr output as log records, one per line. Its `error: …` is an ERROR of
 * `cli`, with a following `(Did you mean …?)` line appended to that same record; the
 * help it shows after an error is one INFO record per non-blank line. A run with global
 * options but no command (or `help` with an unknown topic) makes commander show the
 * help as an error (exit 1) with no `error:` line: an ERROR record "missing command:
 * `fit-connect <subcommand>`" comes first, so every failed run has one.
 */
function writeCommanderErr(command: Command, deps: CliDeps, state: { errorLogged: boolean }, str: string): void {
  const log = logOf(deps);
  const text = str.replace(/\n$/, "");
  // The blank line showHelpAfterError writes between an error and the help it shows after.
  if (text.trim() === "") return;
  if (text.startsWith("error: ")) {
    state.errorLogged = true;
    log.error("cli", text.slice("error: ".length).replace(/\n(\(Did you mean .*\?\))$/, " $1"));
    return;
  }
  if (!state.errorLogged) {
    state.errorLogged = true;
    log.error("cli", `missing command: \`${commandPath(command)} <subcommand>\``);
  }
  for (const line of text.split("\n")) if (line.trim() !== "") log.info("cli", line.trimEnd());
}

/**
 * Replace commander's built-in `help [command]` with one that resolves every name it
 * is given. The built-in one looked at the first name only: `fit-connect help nope` printed
 * the root help with no word about "nope", and `fit-connect help routes nope`
 * printed the routes help with exit 0. Now `help a b …` shows the help of `a b`, and
 * an unknown name is reported exactly as `fit-connect a nope` reports it (`error: unknown
 * command 'nope'`, redacted like all output, the usage exit code): the remaining names
 * are parsed by the command they were meant for, which raises commander's own error.
 * Added here rather than in `buildProgram`, so the command tree the website documents
 * stays as commander builds it.
 */
function addHelpCommand(command: Command): void {
  command.helpCommand(false);
  command
    .command("help [command...]")
    .description("display help for command")
    .action(async (names: string[]) => {
      let target = command;
      for (const [i, name] of names.entries()) {
        const sub = target.commands.find((c) => c.name() === name || c.aliases().includes(name));
        if (sub === undefined) {
          // A command without subcommands would run its action on the rest of the names.
          if (target.commands.length === 0) target.error(`error: unknown command '${name}'`, { exitCode: USAGE_EXIT, code: "commander.unknownCommand" });
          try {
            await target.parseAsync(names.slice(i), { from: "user" });
          } catch (err) {
            // The same error as `fit-connect a nope`, but a help request that names a
            // command that is not there ends with the usage exit code.
            if (err instanceof CommanderError && err.exitCode !== 0) throw new CommanderError(USAGE_EXIT, err.code, err.message);
            throw err;
          }
          return;
        }
        target = sub;
      }
      target.help();
    });
}

/**
 * The names (long and short) of the program's own options that require a value
 * (`--user-agent`). Only the program's: commander takes them out of argv wherever they
 * stand, before a subcommand sees the rest, so a subcommand's `--ags` never swallows
 * a `--log-format` after it.
 */
function valueOptionsOf(program: Command): Set<string> {
  const names = new Set<string>();
  for (const option of program.options) {
    if (!option.required) continue;
    if (option.long !== undefined) names.add(option.long);
    if (option.short !== undefined) names.add(option.short);
  }
  return names;
}

/**
 * Replace the userinfo of every URL in `text` with `***`, the form `redactUrl` gives
 * (`https://user:secret@host` becomes `https://***@host`). Text-based, so it also
 * covers a URL that does not parse; a backstop behind the exact-string redaction.
 */
export function redactUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#']*@/gi, "$1***@");
}

/**
 * The options whose value is the base URL: a `user:password@host` given there without
 * its scheme is still a credential (anywhere else a bare `a:b@c` is not).
 */
const BASE_URL_FLAGS = ["--base-url"];

/** The values of the `flags` in `argv`, in both forms (`--flag value`, `--flag=value`). */
function flagValues(argv: readonly string[], flags: readonly string[]): string[] {
  const found: string[] = [];
  argv.forEach((token, i) => {
    const next = argv[i + 1];
    if (flags.includes(token) && next !== undefined) found.push(next);
    const eq = token.indexOf("=");
    if (eq > 0 && flags.includes(token.slice(0, eq))) found.push(token.slice(eq + 1));
  });
  return found;
}

/** The secrets of a run, and the two ways they are replaced. */
export interface Redaction {
  /** stdout text: the userinfo of every URL-like argument replaced (`***@`). */
  out(text: string): string;
  /** stderr text, a record's message: that, and the bare password of a userinfo (`***`). */
  err(text: string): string;
}

/**
 * The secrets of the run in `argv`. Commander echoes rejected values in its errors
 * (`option '--base-url <url>' argument '…' is invalid`, `unknown command '…'`), and the
 * CLI's own messages quote search terms and keys: whatever path a credential takes, the
 * exact userinfo (as `credentialsIn` finds it, plus its JSON-escaped form) is replaced by
 * `***`. A pattern alone can't delimit a password with spaces, quotes, `#`, `?` or `/`;
 * the exact strings can. Without credentials the text passes through unchanged.
 */
export function redactionFor(argv: readonly string[]): Redaction {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const secrets = new Set<string>();
  const echoed = new Set<string>();
  const passwords = new Set<string>();
  // A base URL typed without its scheme is read as if it had one.
  const baseUrls = flagValues(argv, BASE_URL_FLAGS).map((value) => (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`));
  for (const source of [...values, ...baseUrls]) {
    for (const secret of credentialsIn(source)) {
      secrets.add(secret);
      secrets.add(JSON.stringify(secret).slice(1, -1));
      // What a server echoes back: the Basic value and the decoded user:password on
      // stdout and stderr, the password alone (it may well occur in the data) on stderr.
      const [basic, pair, password] = echoedCredentialForms(secret);
      if (basic !== undefined) echoed.add(basic);
      if (pair !== undefined) echoed.add(pair);
      if (password !== undefined) passwords.add(password);
    }
  }
  if (secrets.size === 0) return { out: (text) => text, err: (text) => text };
  const list = [...secrets];
  // Longest first, so a password never leaves half of the user:password around it.
  const echoedList = [...echoed].sort((a, b) => b.length - a.length);
  const passwordList = [...passwords].sort((a, b) => b.length - a.length);
  const out = (text: string): string => redactSecrets(redactUserinfo(redactCredentials(text, list)), echoedList);
  return { out, err: (text) => redactSecrets(out(text), passwordList) };
}

/**
 * `deps` that keep the secrets of this run (`redactionFor`) out of everything they
 * print: `io.out` is redacted, and the log (`deps.log`) replaces them in each record's
 * message before formatting it, then writes to the raw `io.err`, so the frame is never
 * touched. `io.err` itself is redacted too, for anything that writes to stderr without
 * the log.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  const redaction = redactionFor(argv);
  const { out, err } = deps.io;
  return {
    ...deps,
    io: { ...deps.io, out: (text) => out(redaction.out(text)), err: (text) => err(redaction.err(text)) },
    log: createLogger({
      format: logFormatFromArgv(argv),
      write: err,
      redact: redaction.err,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  };
}

/**
 * The log for what happens outside `run()`, in the bin shim: a stdout write error
 * (`handleOutputErrors`) and Node's process warnings (`installWarningLog`). Its format is
 * the one argv asks for (`logFormatFromArgv`), and it replaces the secrets of argv like
 * the run's own log; it writes to the raw stderr.
 */
export function processLogger(argv: readonly string[]): Logger {
  return createLogger({
    format: logFormatFromArgv(argv),
    write: (line) => process.stderr.write(line + "\n"),
    redact: redactionFor(argv).err,
  });
}

/**
 * The log area of a `FitConnectError` that is neither an API error nor a usage error: the
 * connection (`http`), a malformed answer (`api`: bad JSON, the wrong shape, an HTML page
 * answered with 200, an unknown charset — the API's answer as much as an error status
 * is), else `cli`.
 */
function areaOf(err: FitConnectError): string {
  if (err instanceof FitConnectNetworkError) return "http";
  if (err instanceof FitConnectParseError) return "api";
  return "cli";
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  // The log replaces the secrets of the run in every message, in either format.
  deps = withRedactedOutput(deps, argv);
  const program = buildProgram(deps);
  configureTree(program, deps);
  // For the records of a parse error: the scan of argv, now knowing which of the
  // program's options take a value, as commander reads them.
  if (deps.log !== undefined) deps.log.format = logFormatFromArgv(argv, valueOptionsOf(program));
  // One source for the format once commander has parsed argv: its value, not the scan
  // of argv (an option's value can look like --log-format; `--` ends the scan, not
  // commander's parse of a value). Ancestors' hooks run first, so this precedes every
  // other preAction check.
  const log = deps.log;
  program.hook("preAction", (_program, actionCommand) => {
    const format = (actionCommand.optsWithGlobals() as { logFormat?: LogFormat }).logFormat;
    if (log !== undefined) log.format = format ?? DEFAULT_LOG_FORMAT;
  });

  // No arguments at all is a discovery request, not an error: print help to
  // stdout and exit 0 (commander would otherwise dump help to stderr / exit 1).
  if (argv.length === 0) {
    deps.io.out(program.helpInformation());
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version requests exit 0; genuine parse errors carry their own code.
      // A group or the program run without its command is a usage error too, whose
      // exit code is 1 (`help nope` is rewrapped in addHelpCommand); commander's own
      // parse errors keep their code, 1.
      return err.code === "commander.help" && err.exitCode !== 0 ? USAGE_EXIT : err.exitCode;
    }
    const log = logOf(deps);
    if (err instanceof FitConnectApiError) {
      log.error("api", err.message);
      // Map a few notable statuses to distinct exit codes for scripting.
      if (err.status === 404) return 4;
      return 1;
    }
    if (err instanceof FitConnectValidationError) {
      // An input the library rejected before any request: a usage error, which
      // exits 1 here like commander's own parse errors.
      log.error("cli", err.message);
      return 1;
    }
    if (err instanceof FitConnectError) {
      log.error(areaOf(err), err.message);
      return 1;
    }
    log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

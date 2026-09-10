// A tiny arithmetic expression compiler.
//
// JSON plugins map their parameters onto node values through expressions like
// "1 - mix * 0.5" or "db2gain(out)". Those have to be evaluated on every knob
// move, but they must never be `eval`/`new Function` — the whole selling point
// of the JSON tier is that a manifest fetched from a URL cannot execute code.
// So: parse once into a closure tree, then call the closure.
//
// Grammar (lowest precedence first):
//   expr    := term (('+' | '-') term)*
//   term    := unary (('*' | '/' | '%') unary)*
//   unary   := ('-' | '+')* power
//   power   := primary ('^' unary)?          // right-associative
//   primary := number | ident | call | '(' expr ')'

const FUNCS = {
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  pow: Math.pow,
  exp: Math.exp,
  log: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  sqrt: Math.sqrt,
  sign: Math.sign,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  tanh: Math.tanh,
  atan: Math.atan,
  clamp: (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v),
  lerp: (a, b, t) => a + (b - a) * t,
  step: (edge, v) => (v < edge ? 0 : 1),
  /** dB → linear gain, matching the app's -60 dB floor. */
  db2gain: (db) => (db <= -60 ? 0 : Math.pow(10, db / 20)),
  gain2db: (g) => (g <= 0.0001 ? -60 : 20 * Math.log10(g)),
};

const CONSTS = { pi: Math.PI, e: Math.E, true: 1, false: 0 };

export const EXPR_FUNCTIONS = Object.keys(FUNCS);
export const EXPR_CONSTANTS = Object.keys(CONSTS);

const NUM = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    const rest = src.slice(i);
    let m;
    if ((m = NUM.exec(rest))) {
      out.push({ t: "num", v: Number(m[0]), at: i });
      i += m[0].length;
    } else if ((m = IDENT.exec(rest))) {
      out.push({ t: "ident", v: m[0], at: i });
      i += m[0].length;
    } else if ("+-*/%^(),".includes(c)) {
      out.push({ t: c, at: i });
      i++;
    } else {
      throw new SyntaxError(`unexpected character "${c}" at position ${i}`);
    }
  }
  return out;
}

/**
 * Compile `src` into `(scope) => number`.
 *
 * `names` is the set of identifiers the expression is allowed to reference
 * (parameter keys, plus "x" for the parameter being bound). Anything else is a
 * parse error rather than a silent NaN at runtime, so a typo in a manifest is
 * caught at load time and reported with the offending name.
 */
export function compileExpr(src, names = []) {
  if (typeof src === "number") {
    const v = src;
    return () => v;
  }
  if (typeof src !== "string") throw new SyntaxError(`expression must be a string or number`);
  const allowed = new Set([...names, ...Object.keys(CONSTS)]);
  const toks = tokenize(src);
  let p = 0;

  const peek = () => toks[p];
  const eat = (t) => {
    if (toks[p]?.t !== t) throw new SyntaxError(`expected "${t}" in "${src}"`);
    return toks[p++];
  };

  function parseExpr() {
    let left = parseTerm();
    while (peek()?.t === "+" || peek()?.t === "-") {
      const op = toks[p++].t;
      const right = parseTerm();
      const l = left;
      left = op === "+" ? (s) => l(s) + right(s) : (s) => l(s) - right(s);
    }
    return left;
  }

  function parseTerm() {
    let left = parseUnary();
    while (peek()?.t === "*" || peek()?.t === "/" || peek()?.t === "%") {
      const op = toks[p++].t;
      const right = parseUnary();
      const l = left;
      left = op === "*" ? (s) => l(s) * right(s) : op === "/" ? (s) => l(s) / right(s) : (s) => l(s) % right(s);
    }
    return left;
  }

  function parseUnary() {
    if (peek()?.t === "-") {
      p++;
      const inner = parseUnary();
      return (s) => -inner(s);
    }
    if (peek()?.t === "+") {
      p++;
      return parseUnary();
    }
    return parsePower();
  }

  function parsePower() {
    const base = parsePrimary();
    if (peek()?.t === "^") {
      p++;
      const exp = parseUnary(); // right-associative: 2^3^2 === 2^9
      return (s) => Math.pow(base(s), exp(s));
    }
    return base;
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) throw new SyntaxError(`unexpected end of expression "${src}"`);
    if (tok.t === "num") {
      p++;
      return () => tok.v;
    }
    if (tok.t === "(") {
      p++;
      const inner = parseExpr();
      eat(")");
      return inner;
    }
    if (tok.t === "ident") {
      p++;
      const name = tok.v;
      if (peek()?.t === "(") {
        p++;
        const args = [];
        if (peek()?.t !== ")") {
          args.push(parseExpr());
          while (peek()?.t === ",") {
            p++;
            args.push(parseExpr());
          }
        }
        eat(")");
        const fn = FUNCS[name];
        if (!fn) throw new SyntaxError(`unknown function "${name}()" in "${src}"`);
        return (s) => fn(...args.map((a) => a(s)));
      }
      if (name in CONSTS) {
        const v = CONSTS[name];
        return () => v;
      }
      if (!allowed.has(name)) {
        throw new SyntaxError(`unknown name "${name}" in "${src}" (known: ${[...allowed].sort().join(", ") || "none"})`);
      }
      return (s) => {
        const v = s[name];
        return typeof v === "number" ? v : v === true ? 1 : v === false ? 0 : Number(v) || 0;
      };
    }
    throw new SyntaxError(`unexpected "${tok.t}" in "${src}"`);
  }

  const fn = parseExpr();
  if (p !== toks.length) throw new SyntaxError(`trailing input in "${src}"`);
  return (scope) => {
    const v = fn(scope);
    return Number.isFinite(v) ? v : 0;
  };
}

/** Compile a value that may be a literal number or an expression string. */
export const compileValue = (v, names) => compileExpr(v, names);

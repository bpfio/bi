import { describe, expect, test } from "bun:test";
import { lexDebug } from "./shell-scan";

function wordTexts(input: string): string[] {
  return lexDebug(input)
    .tokens.filter((t) => t.t === "word")
    .map((t) => t.text);
}

function opValues(input: string): string[] {
  return lexDebug(input)
    .tokens.filter((t) => t.t === "op")
    .map((t) => t.value);
}

describe("lexer smoke", () => {
  test("plain words", () => {
    expect(wordTexts("echo hello world")).toEqual(["echo", "hello", "world"]);
  });

  test("pipeline operators", () => {
    expect(opValues("a | b && c || d; e & f |& g")).toEqual([
      "|",
      "&&",
      "||",
      ";",
      "&",
      "|&",
    ]);
  });

  test("single quotes preserve spaces", () => {
    const tokens = lexDebug("echo 'a  b'").tokens;
    const word = tokens[1];
    expect(word && word.t === "word" ? word.word.staticText : "").toBe("a  b");
    expect(wordTexts("echo 'a  b'")).toEqual(["echo", "'a  b'"]);
  });

  test("double quote escape", () => {
    expect(wordTexts('echo "a \\"b\\""')).toEqual(["echo", '"a \\"b\\""', ]);
  });

  test("variable expansion detected", () => {
    const tokens = lexDebug("echo $FOO ${BAR} $((1+2))").tokens;
    const words = tokens.filter((t) => t.t === "word");
    expect(words).toHaveLength(4);
    const first = words[1];
    if (first && first.t === "word") {
      expect(first.word.hasExpansion).toBe(true);
      expect(first.word.hasUnquotedExpansion).toBe(true);
      expect(first.word.staticText).toBe(null);
    }
  });

  test("quoted expansion marks quoted not unquoted", () => {
    const tokens = lexDebug('echo "$FOO"').tokens;
    const word = tokens[1];
    if (word && word.t === "word") {
      expect(word.word.hasExpansion).toBe(true);
      expect(word.word.hasUnquotedExpansion).toBe(false);
      expect(word.word.quoted).toBe(true);
    }
  });

  test("cmdsub captured with inner text", () => {
    const tokens = lexDebug("echo $(date -u)").tokens;
    const word = tokens[1];
    if (word && word.t === "word") {
      expect(word.word.hasCmdSubstitution).toBe(true);
      expect(word.word.cmdSubs).toHaveLength(1);
      expect(word.word.cmdSubs[0]?.inner).toBe("date -u");
    }
  });

  test("backtick cmdsub", () => {
    const tokens = lexDebug("echo `date`").tokens;
    const word = tokens[1];
    if (word && word.t === "word") {
      expect(word.word.cmdSubs[0]?.kind).toBe("backtick");
      expect(word.word.cmdSubs[0]?.inner).toBe("date");
    }
  });

  test("redirect matrix", () => {
    const r = lexDebug("a > f >> g < h <> l >| m 2> n &> o &>> p 2>&1 >&2");
    expect(
      r.tokens
        .filter((t) => t.t === "redirect")
        .map((t) => (t.t === "redirect" ? `${t.fd ?? ""}:${t.op}` : "")),
    ).toEqual([
      ":>",
      ":>>",
      ":<",
      ":<>",
      ":>|",
      "2:>",
      ":&>",
      ":&>>",
      "2:>&",
      ":>&",
    ]);
  });

  test("heredoc body captured raw", () => {
    const r = lexDebug("cat << EOF\nline1\nline2\nEOF\necho done");
    expect(r.heredocs).toHaveLength(1);
    const h = r.heredocs[0];
    if (h) {
      expect(h.matched).toBe(true);
      expect(h.delimiter).toBe("EOF");
      expect(h.text).toBe("line1\nline2");
    }
    expect(wordTexts("cat << EOF\nline1\nline2\nEOF\necho done")).toEqual([
      "cat",
      "EOF",
      "echo",
      "done",
    ]);
  });

  test("heredoc <<- strips tabs for match", () => {
    const r = lexDebug("cat <<-\tEOF\n\t\tbody\n\tEOF\nnext");
    const h = r.heredocs[0];
    expect(h?.matched).toBe(true);
    expect(h?.text).toBe("\t\tbody");
  });

  test("unmatched heredoc diagnostic", () => {
    const r = lexDebug("cat << EOF\nbody\nEOFX");
    expect(r.heredocs[0]?.matched).toBe(false);
    expect(r.diagnostics.some((d) => d.code === "heredoc-unmatched")).toBe(true);
  });

  test("unterminated single quote", () => {
    const r = lexDebug("echo 'abc");
    expect(r.diagnostics.some((d) => d.code === "unterminated-construct")).toBe(true);
  });

  test("line continuation joins word", () => {
    const tokens = lexDebug("echo a\\\nb").tokens;
    const w = tokens[1];
    expect(w && w.t === "word" ? w.word.staticText : "").toBe("ab");
  });

  test("comments captured", () => {
    const r = lexDebug("echo hi # note");
    const comment = r.tokens.find((t) => t.t === "comment");
    expect(comment?.text).toBe("# note");
    expect(wordTexts("echo hi # note")).toEqual(["echo", "hi"]);
  });

  test("mid-word hash is literal", () => {
    expect(wordTexts("echo a#b")).toEqual(["echo", "a#b"]);
  });

  test("CRLF tolerated", () => {
    expect(wordTexts("echo a\r\necho b\r\n")).toEqual(["echo", "a", "echo", "b"]);
  });

  test("reserved keywords flagged", () => {
    const tokens = lexDebug("if then fi").tokens;
    const words = tokens.filter((t) => t.t === "word");
    expect(words.every((w) => (w.t === "word" ? w.word.isReserved : false))).toBe(true);
  });

  test("quoted keyword not reserved", () => {
    const tokens = lexDebug("'if'").tokens;
    const w = tokens[0];
    expect(w && w.t === "word" ? w.word.isReserved : true).toBe(false);
  });

  test("assignment detected", () => {
    const tokens = lexDebug("FOO=bar cmd").tokens;
    const w = tokens[0];
    expect(w && w.t === "word" ? w.word.isAssignment : false).toBe(true);
  });

  test("quoted assignment prefix is not assignment", () => {
    const tokens = lexDebug('"FOO=bar" cmd').tokens;
    const w = tokens[0];
    expect(w && w.t === "word" ? w.word.isAssignment : true).toBe(false);
  });

  test("zsh =() flagged unsupported", () => {
    const r = lexDebug("=(prog)");
    expect(r.diagnostics.some((d) => d.code === "unsupported-construct")).toBe(true);
  });

  test("brace group operators", () => {
    expect(opValues("{ echo; }")).toEqual(["{", ";", "}"]);
  });

  test("brace mid-word literal", () => {
    expect(wordTexts("echo {a,b}")).toEqual(["echo", "{a,b}"]);
  });

  test("nested cmdsub inner captured", () => {
    const tokens = lexDebug("echo $(outer $(inner))").tokens;
    const word = tokens[1];
    if (word && word.t === "word") {
      expect(word.word.cmdSubs).toHaveLength(1);
      expect(word.word.cmdSubs[0]?.inner).toBe("outer $(inner)");
    }
  });

  test("cmdsub inside braces recorded", () => {
    const tokens = lexDebug('echo "${X:-$(fallback)}"').tokens;
    const word = tokens[1];
    if (word && word.t === "word") {
      expect(word.word.cmdSubs).toHaveLength(1);
      expect(word.word.cmdSubs[0]?.inner).toBe("fallback");
    }
  });
});

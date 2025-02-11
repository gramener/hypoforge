// import { render, html } from "https://cdn.jsdelivr.net/npm/lit-html@3/+esm";
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v0.27.0/full/pyodide.mjs";
import { asyncLLM } from "https://cdn.jsdelivr.net/npm/asyncllm@2";
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import { Marked } from "https://cdn.jsdelivr.net/npm/marked@13/+esm";
import hljs from "https://cdn.jsdelivr.net/npm/highlight.js@11/+esm";
import { parse } from "https://cdn.jsdelivr.net/npm/partial-json@0.1.7/+esm";

const $demos = document.getElementById("demos");
const $hypotheses = document.getElementById("hypotheses");
const $hypothesisPrompt = document.getElementById("hypothesis-prompt");
const $status = document.getElementById("status");
const loading = `<div class="text-center my-5"><div class="spinner-border" role="status"></div></div>`;

let pyodide;
let data;
let description;
let hypotheses;

const marked = new Marked();
marked.use({
  renderer: {
    table(header, body) {
      return `<table class="table table-sm">${header}${body}</table>`;
    },
    code(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      return /* html */ `<pre class="hljs language-${language}"><code>${hljs
        .highlight(code, { language })
        .value.trim()}</code></pre>`;
    },
  },
});

// Load configurations and render the demos
$status.innerHTML = loading;
const { demos } = await fetch("config.json").then((r) => r.json());
$demos.innerHTML = demos
  .map(
    ({ title, body }, index) => /* html */ `
      <div class="col py-3">
        <a class="demo card h-100 text-decoration-none" href="#" data-index="${index}">
          <div class="card-body">
            <h5 class="card-title">${title}</h5>
            <p class="card-text">${body}</p>
          </div>
        </a>
      </div>
    `
  )
  .join("");

// Ensure that the user is logged in
const { token } = await fetch("https://llmfoundry.straive.com/token", {
  credentials: "include",
}).then((res) => res.json());
if (!token) {
  const url = "https://llmfoundry.straive.com/login?" + new URLSearchParams({ next: location.href });
  $hypotheses.innerHTML = /* html */ `<div class="text-center my-5"><a class="btn btn-lg btn-primary" href="${url}">Log in to analyze</a></div>`;
  throw new Error("User is not logged in");
}

const numFormat = new Intl.NumberFormat("en-US", {
  style: "decimal",
  notation: "compact",
  compactDisplay: "short",
});
const num = (val) => numFormat.format(val);
const dateFormat = d3.timeFormat("%Y-%m-%d %H:%M:%S");

const hypothesesSchema = {
  type: "object",
  properties: {
    hypotheses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          hypothesis: {
            type: "string",
          },
          benefit: {
            type: "string",
          },
        },
        required: ["hypothesis", "benefit"],
        additionalProperties: false,
      },
    },
  },
  required: ["hypotheses"],
  additionalProperties: false,
};

const describe = (data, col) => {
  const values = data.map((d) => d[col]);
  const firstVal = values[0];
  if (typeof firstVal === "string") {
    // Return the top 3 most frequent values
    const freqMap = d3.rollup(
      values,
      (v) => v.length,
      (d) => d
    );
    const topValues = Array.from(freqMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([val, count]) => `${val.length > 100 ? val.slice(0, 100) + "..." : val} (${count})`);
    return `string. ${[...freqMap.keys()].length} unique values. E.g. ${topValues.join(", ")}`;
  } else if (typeof firstVal === "number") {
    return `numeric. mean: ${num(d3.mean(values))} min: ${num(d3.min(values))} max: ${num(d3.max(values))}`;
  } else if (firstVal instanceof Date) {
    return `date. min: ${dateFormat(d3.min(values))} max: ${dateFormat(d3.max(values))}`;
  }
  return "";
};

// When the user clicks on a demo, analyze it
$demos.addEventListener("click", async (e) => {
  e.preventDefault();
  const $demo = e.target.closest(".demo");
  if (!$demo) return;

  const demo = demos[+$demo.dataset.index];
  data = await d3.csv(demo.href, d3.autoType);
  const columnDescription = Object.keys(data[0])
    .map((col) => `- ${col}: ${describe(data, col)}`)
    .join("\n");
  const numColumns = Object.keys(data[0]).length;
  description = `The Pandas DataFrame df has ${data.length} rows and ${numColumns} columns:\n${columnDescription}`;
  const systemPrompt = $hypothesisPrompt.value || demo.audience;
  if (!$hypothesisPrompt.value) $hypothesisPrompt.value = demo.audience;
  const body = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: description },
    ],
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: { name: "hypotheses", strict: true, schema: hypothesesSchema },
    },
  };

  for await (const { content } of asyncLLM("https://llmfoundry.straive.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}:hypoforge` },
    body: JSON.stringify(body),
  })) {
    if (!content) continue;
    ({ hypotheses } = parse(content));
    drawHypotheses();
  }
});

function drawHypotheses() {
  if (!Array.isArray(hypotheses)) return;
  $hypotheses.innerHTML = hypotheses
    .map(
      ({ hypothesis, benefit }, index) => /* html */ `
      <div class="hypothesis col py-3" data-index="${index}">
        <div class="card h-100">
          <div class="card-body">
            <h5 class="card-title">${hypothesis}</h5>
            <p class="card-text">${benefit}</p>
          </div>
          <div class="card-footer">
            <button type="button" class="btn btn-sm btn-primary test-hypothesis" data-index="${index}">Test</button>
            <div class="result"></div>
            <div class="outcome"></div>
          </div>
        </div>
      </div>
    `
    )
    .join("");
}

$hypotheses.addEventListener("click", async (e) => {
  const $hypothesis = e.target.closest(".test-hypothesis");
  if (!$hypothesis) return;
  const index = $hypothesis.dataset.index;
  const hypothesis = hypotheses[index];

  const systemPrompt = document.getElementById("analysis-prompt").value;
  const body = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Hypothesis: ${hypothesis.hypothesis}\n\n${description}` },
    ],
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0,
  };

  const $resultContainer = $hypothesis.closest(".card");
  const $result = $resultContainer.querySelector(".result");
  const $outcome = $resultContainer.querySelector(".outcome");
  let generatedContent;
  for await (const { content } of asyncLLM("https://llmfoundry.straive.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}:hypoforge` },
    body: JSON.stringify(body),
  })) {
    if (!content) continue;
    generatedContent = content;
    $result.innerHTML = marked.parse(content);
  }

  // Extract the code inside the last ```...``` block
  const code = [...generatedContent.matchAll(/```python\n*([\s\S]*?)\n```(\n|$)/g)].at(-1)[1];
  if (pyodide) {
    $outcome.innerHTML = loading;
    pyodide.globals.set("data", pyodide.toPy(data));
    try {
      pyodide.runPython(code + "\n\nresult = test_hypothesis(pd.DataFrame(data))");
    } catch (e) {
      $outcome.innerHTML = `<div class="alert alert-danger">${e.message}</div>`;
      return;
    }
    const [result, pValue] = pyodide.globals.get("result").toJs();
    $outcome.innerHTML = loading;

    const body = {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `You are an expert data analyst.
Given a hypothesis and its outcome, provide a plain English summary of the findings as a crisp H5 heading (#####), followed by 1-2 concise supporting sentences.
Highlight in **bold** the keywords in the supporting statements.
Do not mention the p-value but _interpret_ it to support the conclusion quantitatively.` },
        { role: "user", content: `Hypothesis: ${hypothesis.hypothesis}\n\n${description}\n\nResult: ${result}. p-value: ${num(pValue)}` },
      ],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
    };
    for await (const { content } of asyncLLM("https://llmfoundry.straive.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}:hypoforge` },
      body: JSON.stringify(body),
    })) {
      if (!content) continue;
      $outcome.innerHTML = marked.parse(content);
    }
  }
});

pyodide = await loadPyodide();
await pyodide.loadPackage(["numpy", "pandas", "scipy"]);
$status.innerHTML = "";

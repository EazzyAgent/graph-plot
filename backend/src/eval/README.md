# Eval Module Plan

## Goal

Implement an evaluation process that takes:

- a `message`
- a `figure`

and returns:

- binary metrics derived from the message against the figure
- a score calculated from those metrics
- optional reasoning and failure details

The core idea is:

1. Read the `message` as the evaluation instruction or expected description.
2. Inspect the `figure`.
3. Convert the evaluation into a fixed set of binary checks.
4. Compute a numeric score from the binary checks.

## What This Folder Should Contain

Suggested Nest structure:

- `eval.module.ts`
- `eval.controller.ts`
- `eval.service.ts`
- `eval.types.ts`
- `eval.controller.spec.ts`
- `eval.service.spec.ts`

If evaluation logic becomes large, split into sub-files:

- `metric-builder.ts`
- `score-calculator.ts`
- `figure-parser.ts`
- `eval.prompts.ts`

## Core Concepts

### 1. Message

The `message` defines what should be true about the figure.

Examples:

- "The plot should contain exactly two lines."
- "The x-axis should be labeled Time and the y-axis should be labeled Value."
- "There should be a red upward trend line."

### 2. Figure

The `figure` is the object being evaluated.

Depending on the system design, this can be:

- an image URL
- a base64 image
- an uploaded file reference
- a structured figure object

For now, keep the API flexible enough to support at least one of:

- `figureUrl`
- `figureBase64`

### 3. Binary Metrics

Each metric must resolve to:

- `1` for pass
- `0` for fail

Examples:

- `has_two_lines`
- `has_x_axis_label`
- `has_y_axis_label`
- `has_red_line`
- `shows_upward_trend`

Each metric should also include:

- `name`
- `description`
- `value`
- optional `reason`

## Recommended Flow

### Step 1. Parse the message

Convert the free-form message into a list of explicit checks.

Example:

Message:

`"The figure should have two blue bars and a title."`

Parsed checks:

- figure has bars
- bar count equals 2
- bar color is blue
- title exists

### Step 2. Evaluate the figure

Run the checks against the figure.

This can be implemented in two ways:

- deterministic logic if the figure is structured data
- LLM or vision-model-assisted judgment if the figure is an image

### Step 3. Produce binary metric results

Example:

```json
[
  {
    "name": "has_bars",
    "description": "Figure contains bars",
    "value": 1
  },
  {
    "name": "bar_count_is_2",
    "description": "Figure contains exactly 2 bars",
    "value": 0,
    "reason": "Detected 3 bars"
  },
  {
    "name": "title_exists",
    "description": "Figure has a title",
    "value": 1
  }
]
```

### Step 4. Calculate score

Baseline scoring rule:

```text
score = passed_metrics / total_metrics
```

Return both:

- raw score from `0` to `1`
- percentage score from `0` to `100`

Example:

- passed metrics: `2`
- total metrics: `3`
- score: `0.6667`
- percentage: `66.67`

## Suggested Types

```ts
export interface EvalRequest {
  message: string;
  figureUrl?: string;
  figureBase64?: string;
}

export interface EvalMetric {
  name: string;
  description: string;
  value: 0 | 1;
  reason?: string;
}

export interface EvalResult {
  message: string;
  metrics: EvalMetric[];
  passedCount: number;
  failedCount: number;
  totalCount: number;
  score: number;
  percentage: number;
}
```

## Suggested API

### `POST /api/eval`

Input:

```json
{
  "message": "The figure should have two blue bars and a title.",
  "figureUrl": "https://example.com/figure.png"
}
```

Output:

```json
{
  "message": "The figure should have two blue bars and a title.",
  "metrics": [
    {
      "name": "has_bars",
      "description": "Figure contains bars",
      "value": 1
    },
    {
      "name": "bar_count_is_2",
      "description": "Figure contains exactly 2 bars",
      "value": 0,
      "reason": "Detected 3 bars"
    },
    {
      "name": "title_exists",
      "description": "Figure has a title",
      "value": 1
    }
  ],
  "passedCount": 2,
  "failedCount": 1,
  "totalCount": 3,
  "score": 0.6667,
  "percentage": 66.67
}
```

## Implementation Notes

### Metric generation

This should be deterministic at the response format level.

Even if an LLM is used, the output should always be normalized into:

- a fixed array of metric objects
- binary values only
- a computed score

### Score calculation

Keep this rule outside the LLM.

The LLM may suggest metrics, but the backend should compute:

- `passedCount`
- `failedCount`
- `totalCount`
- `score`
- `percentage`

### Validation

Reject requests when:

- `message` is empty
- neither `figureUrl` nor `figureBase64` is provided
- both figure inputs are invalid

### Future extension

Possible additions later:

- weighted metrics
- confidence scores
- rubric-based scoring
- metric categories such as `structure`, `style`, `content`, `labels`
- storing eval history
- comparing multiple figures against the same message

## Recommended First Version

Implement the first version in this order:

1. Define request/result types in `eval.types.ts`
2. Add `POST /api/eval`
3. Add a simple metric builder for message -> binary checks
4. Add score calculation in backend code
5. Add unit tests for:
   - empty input rejection
   - score calculation
   - binary metric normalization
6. Add one e2e test for the endpoint

## Design Rule

The output of this module should always be machine-usable.

That means:

- metrics are explicit
- metrics are binary
- score is computed by code
- free-form reasoning is optional and secondary

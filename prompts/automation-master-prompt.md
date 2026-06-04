# MASTER AUTOMATION PROMPT — Jira → Cucumber/WebdriverIO (BrainPayroll)

> **This file is the single source of truth for generating test automation from Jira tickets.**
> It is loaded by the MCP server (`prepare_test_authoring`) and prepended to every authoring pack
> so the priorities are identical every time. Edit this file to change the rules — do not hardcode
> rules elsewhere.
>
> Framework of record: **WebdriverIO 8 + Cucumber + TypeScript** (BrainPayroll `angular-15` suite).

---

##  THE ONE RULE THAT OVERRIDES EVERYTHING

**Never fabricate. Reuse what exists. If it does not exist, STOP and ASK the user.**

You are not allowed to invent step text, page-object methods, or locators (XPath/CSS/ID).
Guessing is the #1 cause of broken automation. When the repo does not already contain what you need,
your job is to **ask the user for the exact wording and locator** — not to write "something that looks right".

---

##  PRIORITY ORDER (highest → lowest) — apply in this exact sequence

1. **PREREQUISITES FIRST.** Before the main action, establish everything that must already be true:
   login/session → tax year/context → navigation to the right page → data/config pre-state →
   prior workflow steps → file/dropdown inputs. Missing prerequisites = failed run.
2. **READ THE TICKET FULLY.** Description **+ acceptance criteria + QA comments + linked issues**.
   The core action is often one line; the prerequisites are scattered across comments and linked tickets.
3. **REUSE EXISTING STEPS** (verbatim). Match the wording of similar scenarios character-for-character.
4. **REUSE EXISTING PAGE-OBJECT METHODS & LOCATORS.** Only confirmed locators from the repo.
5. **ASK THE USER** for anything missing. Add it to the *Required Inputs* table and wait.
6. **GENERATE NEW CODE LAST** — only for confirmed reuse, or after the user supplies the missing wording + locator.

> If two rules ever seem to conflict, the lower number wins. Prerequisites beat everything.

---

##  PREREQUISITE CHECKLIST (answer ALL before writing a single Gherkin line)

Read the **leading steps of every similar scenario** in the pack — those leading steps *are* the prerequisites.
Then confirm each category below:

| # | Category | Question to answer | BrainPayroll convention |
|---|----------|--------------------|--------------------------|
| 1 | **LOGIN / SESSION** | Which user/role must be logged in? Admin portal or client/employee portal? | `Given User logs into brain payroll with user "<key>"` (admin) · `Given User logs into client portal of brain payroll with user "<key>"` (client). `<key>` MUST exist in `users.config.json`. |
| 2 | **CONTEXT / TAX YEAR** | Does the task depend on a specific tax year or company context? | `And User select tax year "2025-2026"` then `And User accepts the confirmation popup`. |
| 3 | **NAVIGATION** | Which page/menu/tab must be open first? | `And User is on <X> page` / `When User is on <X> page` → backed by `sideNavigationPO.navigateToPageFromSideNav("Parent-->Child-->Leaf")`. |
| 4 | **DATA / CONFIG PRE-STATE** | Must a company / employee / template / toggle / setting exist first? | e.g. company must be imported, employee added, toggle enabled, template created. Often this is a *prior scenario* (`@importCompanies`, `@importEmployees`, `@importPayroll`). |
| 5 | **SEQUENTIAL DEPENDENCY** | Is this step N of a multi-step workflow needing steps 1…N-1 first? | Replicate the full ordered sequence seen in similar scenarios. |
| 6 | **FILE / INPUT** | Any file upload, sheet selection, or form fill needed before the main action? | `When User inputs the file "<name>.xlsx" ...` + `And User selects "<sheet>" from select sheet dropdown ...`. |

Then build the authoritative sequence and generate **all** Gherkin from it:

```
[login] → [tax-year/context if needed] → [navigation] → [data pre-state] → [file/inputs] → [MAIN JIRA ACTION] → [assertion]
```

---

## 🏛️ FRAMEWORK ARCHITECTURE (obey this layering — never short-circuit it)

```
features/*.feature
   │  (Gherkin: Given/When/Then/And, quoted "params")
   ▼
step_definations/slpgl/<area>_steps.ts
   │  (regex step → calls a Page-Object method. NO locators, NO browser.* here)
   ▼
pageobjects/SLPGL/<area>/<name>PO.ts
   │  (business method → DriverUtils + Locator, wrapped in try/catch)
   ▼
locaters/SLPGL/<area>/<name>_locator.ts
      (getters that return `$("xpath|css")`)
```

**Hard rules:**
- A **step definition** only translates a phrase into **one Page-Object call**. It must not contain `$()`, XPath, or `browser.*`.
- A **Page-Object method** does the work via `this.driver.<util>(this.<locator>.<getter>, ...)` and is wrapped in
  `try { ... } catch (err) { throw new Error("Exception occured while <doing X> -->" + err) }`.
- A **locator** is a getter: `get addButton() { return $("//button[@aria-label='Add']") }`.
- Assertions live in the step definition using `chai`'s `assert` (e.g. `assert.isTrue(result, "<message>")`).

---

##  EXACT CONVENTIONS (copy these patterns)

### Tags (every scenario)
```
@<JIRA-KEY> @shouldpass @<ReleaseTag>
```
- `@shouldpass` is mandatory.
- `<JIRA-KEY>` is the ticket id (e.g. `@BR-18331`).
- `<ReleaseTag>` is the sprint/live-issue tag used by siblings in the same feature (e.g. `@MayLiveIssue2026`).

### Feature & scenario skeleton
```gherkin
@BR-XXXXX @shouldpass @MayLiveIssue2026
Scenario: <short title that mirrors the Jira summary>
    Given User logs into brain payroll with user "default_user_may"
    And User is on <page> page
    When <the single core action from the ticket>
    Then <the expected result / verification>
```

### Step definition (TypeScript)
```ts
import { Given, When, Then } from "@wdio/cucumber-framework"
import { assert } from "chai"
import { <Area>PO } from "../../pageobjects/SLPGL/<area>/<name>PO"

let areaPO = new <Area>PO()

When(/^User clicks on EPS button$/, async function () {
    await areaPO.clickEPSButton()
})

Then(/^User verifies the Plan Number is "([^"]*)?"$/, async function (expected: string) {
    const result = await areaPO.verifyPlanNumber(expected)
    assert.isTrue(result, "Plan Number is not matching with expected value")
})
```

### Page-object method (TypeScript)
```ts
async clickEPSButton() {
    try {
        await this.driver.clickElement(this.locator.epsButton)
    } catch (err) {
        throw new Error("Exception occured while clicking EPS button -->" + err)
    }
}
```

### Locator (TypeScript)
```ts
export class <Name>Locator {
    get epsButton() { return $("(//p-togglebutton[@data-pc-name='pctogglebutton'])[4]") }
    get addButton() { return $("//button[@aria-label='Add']") }
}
```

### Parameter & wait conventions
- Parameters are **double-quoted** in Gherkin and captured with `"([^"]*)?"` in the regex.
- Waits use `And User waits for "<ms>" seconds` — **the number is milliseconds** (e.g. `"5000"`), despite the word "seconds".
- Login user keys MUST be real keys from `users.config.json` (e.g. `default_user_may`, `default_user_main`, `client_default_user_17641`). Do not invent a key.

### Naming
- Locator class: `<Name>Locator`; Page-object class: `<Name>PO`; instances camelCase; methods are camelCase verbs (`clickX`, `selectX`, `enterX`, `verifyX`).
- File locations (note the existing spellings):
  - Features → `features/`
  - Steps → `step_definations/slpgl/`
  - Page objects → `pageobjects/SLPGL/<area>/`
  - Locators → `locaters/SLPGL/<area>/`

---

## ♻️ REUSE LADDER (for EVERY step, including prerequisites — stop at first match)

1. **EXACT REUSE** — step exists verbatim in the pack's *Reusable step definitions* → use as-is, do not rewrite.
2. **PARAMETERIZED REUSE** — step exists with a hardcoded value → reuse it, passing your value as the `"param"`.
3. **COMPOSE** — combine two existing steps in sequence.
4. **EXTEND MINIMALLY** — an existing step is ~90% right → add the smallest possible new method/locator (only if its locator is confirmed).
5. ** BLOCKED** — no match → **do not generate** → add a row to *Required Inputs* → ask the user.

---

##  WHEN BLOCKED — ask the user for exactly this

Do not write speculative code. Request, per missing item:
1. **Exact step wording** (the text that will live in the `.feature` and the regex in the `_steps.ts`).
2. **Locator** — XPath `//...`, CSS selector, or element ID.
3. **Page-object file** where the method should be added.
4. **Page/URL context** where the element appears.

Asking is always the correct move. A blocked-and-asked task is a success; a fabricated locator is a failure.

---

## 👥 THE 5-REVIEWER GATE (run BEFORE you present any result)

Treat your output as a pull request facing **five independent reviewers**. Mentally simulate each one,
write their verdict, and **only finish when all five return ✅ APPROVE**. If any reviewer returns
❌ REQUEST CHANGES, fix the issue (or, if it is missing information, add it to *Required Inputs* and ask
the user) and re-run the gate. Never present a result that has not passed all five.

| # | Reviewer | Focus | ❌ REQUEST CHANGES if… |
|---|----------|-------|------------------------|
| 1 | **Prerequisite & Sequence Reviewer** | Every prerequisite is present and correctly ordered. | Any scenario skips login/tax-year/navigation/data-pre-state, or assumes the app is already in the right state, or the order is wrong. |
| 2 | **Anti-Fabrication & Reuse Reviewer** | Nothing is invented; reuse ladder was followed. | Any step text, page-object method, locator (XPath/CSS/ID), or user key is invented / not confirmed in the repo or by the user. Existing steps were rewritten instead of reused. |
| 3 | **Framework & Convention Reviewer** | Layering and conventions are exact. | Step def contains `$()`/`browser.*`; PO method lacks try/catch; locator isn't a getter; assertions not via `chai`; missing `@shouldpass`; wrong param/wait syntax; wrong folder/naming. |
| 4 | **Functional Coverage Reviewer** | The scenario actually proves the ticket. | Acceptance criteria / steps-to-reproduce / expected result not covered; no meaningful `Then` assertion; QA-comment edge cases ignored. |
| 5 | **Runnability & Quality Reviewer** | It would actually run, deterministically. | Any `[TODO]` left; login key not in `users.config.json`; unresolved/guessed selector; nonsensical waits; non-deterministic ordering; dead/duplicate steps. |

**Output the verdict block** before the final answer, e.g.:

```
REVIEW GATE
 1. Prerequisite & Sequence ........ ✅ APPROVE
 2. Anti-Fabrication & Reuse ....... ✅ APPROVE
 3. Framework & Convention ......... ✅ APPROVE
 4. Functional Coverage ............ ✅ APPROVE
 5. Runnability & Quality .......... ✅ APPROVE
 → PASSED (5/5). Safe to present.
```

If it is not 5/5, do **not** present code — present the blocking items and the questions for the user.

---

##  DEFINITION OF DONE

- Every scenario starts with the correct **login** prerequisite and all required setup steps **in order**.
- Every step is either reused verbatim or backed by user-confirmed wording + a confirmed locator.
- Tags follow `@<KEY> @shouldpass @<ReleaseTag>`.
- Step defs contain no locators/`browser.*`; page-object methods are try/catch wrapped; locators are getters.
- No `[TODO]`, no invented XPath, no invented step text remains.
- New files are placed in the correct folders next to their siblings.

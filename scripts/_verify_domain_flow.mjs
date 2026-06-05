import { buildTestAuthoringPack } from "./dist/jiraflow/test-authoring.js";

async function run() {
  const mockIntelligence = {
    issue: { key: "BR-9999" },
    summary: "Implement BACS payment",
    plain_description: "We need to send payment using bacs after setting up the company and employees.",
    issue_type: "Story",
    status: "In Progress",
    related_issues: {},
    comments: [],
    media_context: null
  };

  const pack = await buildTestAuthoringPack({
    intelligence: mockIntelligence
  });

  console.log("Data Prerequisites Mined:");
  pack.kb.data_prerequisites.forEach(p => console.log("- " + p));
}

run().catch(console.error);

const core = require('@actions/core');
const github = require('@actions/github');

try {
    // `who-to-greet` input defined in action metadata file
    const nameToGreet = core.getInput('dry-run');
    console.log(`Hello ${nameToGreet}!`);
    const time = (new Date()).toTimeString();
    core.setOutput("new-tag", "hello world);
    core.setOutput("tag", time);
    // Get the JSON webhook payload for the event that triggered the workflow
    const payload = JSON.stringify(github.context.payload, undefined, 2)
    console.log(`The event payload: ${payload}`);
    
    const payload2 = JSON.stringify(github.context.github, undefined, 2)
    console.log(`The event payload: ${payload2}`);

  } catch (error) {
    core.setFailed(error.message);
  }
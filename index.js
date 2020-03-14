const core = require('@actions/core');
const github = require('@actions/github');

try {
    // `who-to-greet` input defined in action metadata file
    const nameToGreet = core.getInput('dry-run');
    const token = core.getInput('github-token');
    
    console.log(`Hello ${nameToGreet}!`);
    
    const time = (new Date()).toTimeString();

    core.setOutput("new-tag", "hello world");
    core.setOutput("tag", time);

    // Get the JSON webhook payload for the event that triggered the workflow
    const payload = JSON.stringify(github.context, undefined, 2)
    console.log(`The event payload: ${payload}`);

  } 
  catch (error) {
    core.setFailed(error.message);
  }
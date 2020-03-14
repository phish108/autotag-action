const core   = require('@actions/core');
const github = require('@actions/github');

async function action() {
    const nameToGreet = core.getInput('dry-run');
    const token = core.getInput('github-token');
    
    console.log(`Hello ${nameToGreet}!`);
    
    const time = (new Date()).toTimeString();

    const octokit = new github.GitHub(token);

    const { data } = await octokit.repos.listTags({
        owner: github.context.payload.repository.owner.name,
        repo: github.context.payload.repository.name
    });

    const tags = data.map((tag) => tag.name);
    const splitTags = tags.map(tag => tag.split(/\w | \./))

    console.log(`The repo tags: ${ JSON.stringify(splitTags, undefined, 2) }`);
    // get tag list

    core.setOutput("new-tag", "hello world");
    core.setOutput("tag", time);

    const payload = JSON.stringify(github.context, undefined, 2)
    console.log(`The event payload: ${payload}`);
}

action()
    .then(() => console.log("success"))
    .catch(error => core.setFailed(error.message))

const core   = require('@actions/core');
const github = require('@actions/github');

function compareTags(a,b) {

}

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

    const latestTag = tags.shift();
    core.setOutput("tag", latestTag.name);

    const splitTags = (latestTag.startsWith("v") ? latestTag.slice(1) : latestTag).split(/\./);

    console.log(`The repo tags: ${ JSON.stringify(latestTag, undefined, 2) }`);

    // find the max(major, minor, and patch)

    // get tag list

    core.setOutput("new-tag", "hello world");
    

    const payload = JSON.stringify(github.context, undefined, 2)
    // console.log(`The event payload: ${payload}`);
}

action()
    .then(() => console.log("success"))
    .catch(error => core.setFailed(error.message))

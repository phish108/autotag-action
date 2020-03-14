const core   = require('@actions/core');
const github = require('@actions/github');
const semver = require('semver');

async function action() {
    const nameToGreet = core.getInput('dry-run');
    const token = core.getInput('github-token');
    const level = core.getInput('bump');
    
    console.log(`Hello ${nameToGreet}!`);
    
    const time = (new Date()).toTimeString();

    const octokit = new github.GitHub(token);

    const { data } = await octokit.repos.listTags({
        owner: github.context.payload.repository.owner.name,
        repo: github.context.payload.repository.name
    });

    const latestTag = data.shift();
    core.setOutput("tag", latestTag.name);

    console.log(`The repo tags: ${ JSON.stringify(latestTag, undefined, 2) }`);

    const version = semver.clean(latestTag.name);
    const nextVersion = semver.inc(version, level);

    console.log( `bump tag ${ nextVersion }` );

    // find the max(major, minor, and patch)

    // get tag list

    core.setOutput("new-tag", nextVersion);
    

    const payload = JSON.stringify(github.context, undefined, 2)
    console.log(`The event payload: ${payload}`);
}

action()
    .then(() => console.log("success"))
    .catch(error => core.setFailed(error.message))

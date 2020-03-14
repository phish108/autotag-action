const core   = require('@actions/core');
const github = require('@actions/github');
const semver = require('semver');

async function action() {
    const dryRun = core.getInput('dry-run').toLowerCase();
    const token = core.getInput('github-token');
    const level = core.getInput('bump');

    const releaseBranch = "master";
    // release branchs other than master
    const curBranch = github.context.ref.split("/").pop()   

    const octokit = new github.GitHub(token);

    const { data } = await octokit.repos.listTags({
        owner: github.context.payload.repository.owner.name,
        repo: github.context.payload.repository.name
    });

    const latestTag = data.shift();
    core.setOutput("tag", latestTag.name);

    if (latestTag.commit.sha === github.context.sha) {
        console.log("nothing to commit");
        core.setOutput("new-tag", latestTag.name);
        return;
    }

    console.log(`The repo tags: ${ JSON.stringify(latestTag, undefined, 2) }`);

    const version = semver.clean(latestTag.name);
    let nextVersion = semver.inc(version, level);

    console.log(`current branch is ${curBranch}`);

    if (curBranch !== releaseBranch) {
        nextVersion = semver.inc(version, "pre"+level, github.context.sha.slice(0, 6));
    }

    console.log( `bump tag ${ nextVersion }` );

    core.setOutput("new-tag", nextVersion);

    const payload = JSON.stringify(github.context, undefined, 2)
    // console.log(`The event payload: ${payload}`);

    if (dryRun === "false") {
        // TODO perform release on the current sha
    }
}

action()
    .then(() => console.log("success"))
    .catch(error => core.setFailed(error.message))

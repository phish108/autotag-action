const core   = require('@actions/core');
const github = require('@actions/github');
const semver = require('semver');

async function getLatestTag(repository) {
    const { data } = await octokit.repos.listTags({
        owner: repository.owner.name,
        repo:  repository.name
    });

    return data.shift();
}

async function action() {
    // Inputs
    const dryRun = core.getInput('dry-run').toLowerCase();
    const token = core.getInput('github-token');
    const level = core.getInput('bump');

    // defaults
    const releaseBranch = "master";

    const actionSha = github.context.sha;

    // release branchs other than master
    const curBranch = github.context.ref.split("/").pop() ;
    const octokit = new github.GitHub(token);

    // if force branch
    console.log("fetch matching heads");

    let { data }  = await octokit.git.listMatchingRefs({
        owner: github.context.payload.repository.owner.name,
        repo: github.context.payload.repository.name,
        ref: `heads/${curBranch}`
    });

    const curHeadSHA = data[0].object.sha;
    
    console.log(`maching refs: ${ JSON.stringify(curHeadSHA, undefined, 2) }`);

    if (actionSha === curHeadSHA) {
        console.log("we tag the triggering commit");
    }

    const latestTag = await getLatestTag(github.context.payload.repository);
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
        console.log("not a release branch, create a prerelease")
        nextVersion = semver.inc(version, "pre"+level, github.context.sha.slice(0, 6));
    }

    console.log( `bump tag ${ nextVersion }` );

    core.setOutput("new-tag", nextVersion);

    const payload = JSON.stringify(github.context, undefined, 2)
    // console.log(`The event payload: ${payload}`);

    if (dryRun === "false") {
        console.log(`execute version bump to ${nextVersion}`);
        // TODO perform release on the current sha

        const result = await octokit.git.createRef({
            owner: github.context.payload.repository.owner.name,
            repo: github.context.payload.repository.name,
            ref: `refs/tags/${nextVersion}`,
            sha: actionSha
        });

        console.log(`tagging result ${ JSON.stringify(result, undefined,2) }`);
    }
}

action()
    .then(() => console.log("success"))
    .catch(error => core.setFailed(error.message))

const core   = require('@actions/core');
const github = require('@actions/github');
const semver = require('semver');

async function getLatestTag(octokit, repository) {
    const { data } = await octokit.repos.listTags({
        owner: repository.owner.name,
        repo:  repository.name
    });

    // ensure the highest version number is the last element
    data.sort((a, b) => semver.compare(semver.clean(a.name), semver.clean(b.name)));

    return data.pop();
}

async function loadBranch(octokit, branch) {
    const result = await octokit.git.listMatchingRefs({
        owner: github.context.payload.repository.owner.name,
        repo: github.context.payload.repository.name,
        ref: `heads/${branch}`
    });

    console.log(`branch data: ${ JSON.stringify(result, undefined, 2) } `);

    return result.data.shift();
}

async function action() {
    // prepare octokit
    const token = core.getInput('github-token');
    const octokit = new github.GitHub(token);
    
    // load inputs
    // const customTag     = core.getInput('custom-tag');
    const dryRun        = core.getInput('dry-run').toLowerCase();
    const level         = core.getInput('bump');
    const forceBranch   = core.getInput('branch');
    const releaseBranch = core.getInput('release-branch');
    const withV         = core.getInput('with-v').toLowerCase() === "false" ? "" : "v";

    let branchInfo;

    if (forceBranch) {
        console.log(`check forced branch ${forceBranch}`);

        branchInfo = await loadBranch(octokit, forceBranch);

        if (!branchInfo) {
            throw new Error("unknown branch provided");       
        }
    
        console.log("branch confirmed, continue");    
    }

    if (!branchInfo) {
        const activeBranch = github.context.ref.split("/").pop();

        console.log(`load the history of activity-branch ${ activeBranch }`);
        branchInfo  = await loadBranch(octokit, activeBranch);
    }
    
    // the tag for tagging
    const sha = branchInfo.object.sha;

    console.log(`maching refs: ${ sha }`);

    const latestTag = await getLatestTag(octokit, github.context.payload.repository);

    console.log(`the previous tag of the repository ${ JSON.stringify(latestTag, undefined, 2) }`);

    core.setOutput("tag", latestTag ? latestTag.name : "0.0.0");

    if (latestTag && latestTag.commit.sha === sha) {
        throw new Error("no new commits, avoid tagging");
    }

    console.log(`The repo tags: ${ JSON.stringify(latestTag, undefined, 2) }`);

    const version   = semver.clean(latestTag.name);
    let nextVersion = semver.inc(
        version, 
        "pre" + level, 
        sha.slice(0, 6)
    );
    
    // check if the current branch is actually a release branch
    const branchName = branchInfo.ref.split("/").pop();
    
    for (const branch of releaseBranch.split(",")) {
        const testBranchName = new RegEx(branch);
        if (testBranchName.test(branchName)) {
            console.log(`${ branchName } is a release branch`);
            nextVersion = semver.inc(version, level);
            break;
        }
    }

    console.log( `bump tag ${ nextVersion }` );

    core.setOutput("new-tag", nextVersion);

    if (dryRun === "true") {
        console.log("dry run, don't perform tagging");
        return
    }

    console.log(`really add tag ${ withV }${ nextVersion }`);

    const ref = `refs/tags/${ withV }${ nextVersion }`;

    const result = await octokit.git.createRef({
        owner: github.context.payload.repository.owner.name,
        repo: github.context.payload.repository.name,
        ref,
        sha
    });
}

action()
    .then(() => console.log("success"))
    .catch(error => core.setFailed(error.message))

const core   = require('@actions/core');
const github = require('@actions/github');
const semver = require('semver');

const owner = github.context.payload.repository.owner.name;
const repo = github.context.payload.repository.name;

async function checkTag(octokit, tagName) {
    const { data } = await octokit.repos.listTags({
        owner,
        repo
    });

    if (data) {
        const result = data.filter(tag => tag.name === tagName);

        if (result.length) {
            return true;
        }
    }

    return false;
}

async function getLatestTag(octokit, boolAll = true) {
    const { data } = await octokit.repos.listTags({
        owner,
        repo
    });

    // ensure the highest version number is the last element
    // strip all non version tags
    const allVTags = data
        .filter(tag => semver.clean(tag.name) !== null);
    
    allVTags
        .sort((a, b) => semver.compare(semver.clean(a.name), semver.clean(b.name)));

    if (boolAll) {
        return allVTags.pop();
    }

    // filter prereleases
    // console.log("filter only main releases");
    
    const filtered = allVTags.filter((b) => semver.prerelease(b.name) === null);
    const result = filtered.pop();

    return result;
}

async function loadBranch(octokit, branch) {
    const result = await octokit.git.listMatchingRefs({
        owner,
        repo,
        ref: `heads/${branch}`
    });

    // console.log(`branch data: ${ JSON.stringify(result.data, undefined, 2) } `);
    return result.data.shift();
}

async function checkMessages(octokit, branchHeadSha, tagSha, issueTags) {
    const sha = branchHeadSha;

    // console.log(`load commits since ${sha}`);

    let releaseBump = "none";

    const result = await octokit.repos.listCommits({
        owner,
        repo,
        sha
    });

    if (!(result && result.data)) {
        return releaseBump;
    }

    const wip   = new RegExp("#wip\\b");
    const major = new RegExp("#major\\b");
    const minor = new RegExp("#minor\\b");
    const patch = new RegExp("#patch\\b");

    const fix   = new RegExp("fix(?:es)? #\\d+");
    const matcher = new RegExp(/fix(?:es)? #(\d+)\b/);

    for (const commit of result.data) {
        // console.log(commit.message);
        const message = commit.commit.message;

        if (commit.sha === tagSha) {
            break;
        }
        // console.log(`commit is : "${JSON.stringify(commit.commit, undefined, 2)}"`);
        // console.log(`message is : "${message}" on ${commit.commit.committer.date} (${commit.sha})`);

        if (wip.test(message)) {
            // console.log("found wip message, skip");
            continue;
        }

        if (major.test(message)) {
            // console.log("found major tag, stop");
            return "major";
        }
        
        if (minor.test(message)) {
            // console.log("found minor tag");

            releaseBump = "minor";
            continue;
        }

        if (releaseBump !== "minor" && patch.test(message)) {
            // console.log("found patch tag");
            releaseBump = "patch";
            continue;
        }

        if (releaseBump !== "minor" && fix.test(message)) {
            // console.log("found a fix message, check issue for enhancements");

            const id = matcher.exec(message);

            if (id && Number(id[1]) > 0) {
                const issue_number = Number(id[1]);

                console.log(`check issue ${issue_number} for minor labels`);

                const { data } = await octokit.issues.get({
                    owner,
                    repo,
                    issue_number    
                });

                if (data) {
                    releaseBump = "patch";

                    for (const label of data.labels) {

                        if (issueTags.indexOf(label.name) >= 0) {
                            console.log("found enhancement issue");
                            releaseBump = "minor";
                            break;
                        }
                    }
                }
            }

            // continue;
        }
        // console.log("no info message");
    }

    return releaseBump;
}

function isReleaseBranch(branchName, branchList) {
    for (const branch of branchList.split(",").map(b => b.trim())) {
        const testBranchName = new RegExp(branch);

        if (testBranchName.test(branchName)) {
            return true;
        }
    }
    return false;
}

async function action() {
    console.log(`payload ${JSON.stringify(github.context, undefined, 2)}`);
    console.log(`run for ${ owner } / ${ repo }`);

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
    const customTag     = core.getInput('tag');
    const issueLabels   = core.getInput('issue-labels');

    let branchInfo, nextVersion;

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
    
    // the sha for tagging
    const sha        = branchInfo.object.sha;
    const branchName = branchInfo.ref.split("/").pop();

    console.log(`active branch name is ${ branchName }`);

    if (customTag){
        if (checkTag(octokit, customTag)) {
            throw new Error(`tag already exists ${customTag}`);
        }

        core.setOutput("new-tag", customTag);
    }
    else {

        console.log(`maching refs: ${ sha }`);

        const latestTag = await getLatestTag(octokit);
        const latestMainTag = await getLatestTag(octokit, false);

        console.log(`the previous tag of the repository ${ JSON.stringify(latestTag, undefined, 2) }`);
        console.log(`the previous main tag of the repository ${ JSON.stringify(latestMainTag, undefined, 2) }`);

        const versionTag = latestTag ? latestTag.name : "0.0.0";

        core.setOutput("tag", versionTag);

        if (latestTag && latestTag.commit.sha === sha) {
            throw new Error("no new commits, avoid tagging");
        }

        console.log(`The repo tags: ${ JSON.stringify(latestTag, undefined, 2) }`);

        const version   = semver.clean(versionTag);

        nextVersion = semver.inc(
            version, 
            "prerelease", 
            branchName
        );

        console.log(`default to prerelease version ${ nextVersion }`);

        let issLabs = ["enhancement"];

        if (issueLabels) {
            const xlabels = issueLabels.split(',').map(lab => lab.trim());

            if (xlabels.length) {
                issLabs = xlabels;
            }
        }

        // check if commits and issues point to a diffent release
        console.log("commits in branch");
        const msgLevel = await checkMessages(octokit, branchInfo.object.sha, latestMainTag.commit.sha,  issLabs);
        // console.log(`commit messages suggest ${msgLevel} upgrade`);
    
        if (isReleaseBranch(branchName, releaseBranch)) {
            console.log(`${ branchName } is a release branch`);

            if (msgLevel === "none") {
                nextVersion = semver.inc(version, level);
            }
            else {
                console.log(`commit messages force bump level to ${msgLevel}`);
                nextVersion = semver.inc(version, msgLevel);
            }
        }

        console.log( `bump tag ${ nextVersion }` );

        core.setOutput("new-tag", nextVersion);
    }

    if (dryRun === "true") {
        console.log("dry run, don't perform tagging");
        return
    }

    const newTag = `${ withV }${ nextVersion }`;

    console.log(`really add tag ${ customTag ? customTag : newTag }`);

    const ref = `refs/tags/${ customTag ? customTag : newTag }`;

    const result = await octokit.git.createRef({
        owner,
        repo,
        ref,
        sha
    });
}

action()
    .then(() => console.log("success"))
    .catch(error => core.setFailed(error.message))

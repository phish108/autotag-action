const core   = require('@actions/core');
const github = require('@actions/github');
const semver = require('semver');

const owner = github.context.payload.repository.owner.name;
const repo = github.context.payload.repository.name;

async function getLatestTag(octokit, boolAll = true) {
    const { data } = await octokit.repos.listTags({
        owner,
        repo
    });

    // ensure the highest version number is the last element
    data.sort((a, b) => semver.compare(semver.clean(a.name), semver.clean(b.name)));

    if (boolAll) {
        return data.pop();
    }

    // filter prereleases
    console.log("filter only main releases");
    
    const filtered = data.filter((b) => semver.prerelease(b.name) === null);
    const result = filtered.pop();

    // console.log(`filtered release ${JSON.stringify(result, undefined, 2)}`);

    return result;
}

async function loadBranch(octokit, branch) {
    const result = await octokit.git.listMatchingRefs({
        owner,
        repo,
        ref: `heads/${branch}`
    });

    console.log(`branch data: ${ JSON.stringify(result, undefined, 2) } `);

    return result.data.shift();
}

async function checkMessages(octokit, latestTag, issueTags) {
    const sha = latestTag.commit.sha;

    let releaseBump = "none";

    const result = await octokit.repos.listCommits({
        owner,
        repo,
        sha
    });

    if (!(result && result.data)) {
        return releaseBump;
    }

    const wip   = new RegExp("#wip");
    const major = new RegExp("\b#?major\b");
    const minor = new RegExp("\b#?minor\b");
    const patch = new RegExp("\b#?patch\b");

    const fix   = new RegExp("fix(?:es)? #\d");
    const matcher = new RegExp(/fix(?:es)? #(\d+)\b/);

    for (const commit of result.data) {
        // console.log(commit.message);
        const message = commit.commit.message;

        console.log(`message is : "${message}"`);

        if (wip.test(message)) {
            console.log("    found wip message, skip");
            continue;
        }

        if (major.test(message)) {
            console.log("    found major tag, stop");

            releaseBump = "major";
            break;
        }
        
        if (minor.test(message)) {
            console.log("    found minor tag");

            releaseBump = "minor";
            continue;
        }

        if (releaseBump !== "minor" && patch.test(message)) {
            console.log("    found patch tag");
            releaseBump = "patch";
            continue;
        }

        if (releaseBump !== "minor" && fix.test(message)) {
            console.log("    found a fix message, check issue for enhancements");
            releaseBump = "patch";

            const id = matcher.exec(message);

            if (id && Number(id[1]) > 0) {
                const issue_number = Number(id[1]);

                console.log(`    check issue ${issue_number} for minor labels`);

                const { data } = await octokit.issues.get({
                    owner,
                    repo,
                    issue_number    
                });

                if (data) {
                    for (const label of data.labels) {

                        if (issueTags.indexOf(label.name) >= 0) {
                            console.log("    found enhancement issue");
                            releaseBump = "minor";
                            break;
                        }
                    }
                }
                else {
                    console.log("    invalid issue");
                }
            }
        }
    }

    return releaseBump;
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

    if (customTag) {
        // TODO check if the tag exists, and if not dryRun, then the previous tag should be removed.

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
        const msgLevel = await checkMessages(octokit, latestMainTag, issLabs);
        const msgLevelB = await checkMessages(octokit, latestTag, issLabs);

        console.log(`commit messages suggest ${msgLevel} upgrade`);
        console.log(`commit messages since minor suggest ${msgLevelB} upgrade`);
        
        for (const branch of releaseBranch.split(",").map(b => b.trim())) {
            const testBranchName = new RegExp(branch);

            if (testBranchName.test(branchName)) {
                console.log(`${ branchName } is a release branch`);

                if (msgLevel === "none") {
                    nextVersion = semver.inc(version, level);
                }
                else {
                    console.log(`commit messages force bump level to ${msgLevel}`);
                    nextVersion = semver.inc(version, msgLevel);
                }

                break;
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

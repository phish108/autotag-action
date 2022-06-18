// import * as core from "@actions/core";
// import * as github from "@actions/github";
// import * as semver from "semver";

const core   = require("@actions/core");
const github = require("@actions/github");
const semver = require("semver");

function getParameters() {
    const retval = {};
    const Parameters = [
        "branch",
        "bump",
        "dry-run",
        "force",
        "github-token",
        "issue-labels" ,
        "release-branch",
        "style",
        "tag",
        "version-prefix",
        "with-v"
    ];

    const Styles = [
        "semver",
        "date",
        "datetime",
        "dotdate",
        "dotdatetime",
        "isodate",
        "isodatetime"
    ];

    // helper for direct value remapping
    const Remap = {
        "github-token": "token",
        "issue-labels": "labels",
        "release-branch": "releaseBranch",
        "version-prefix": "prefix"
    };

    Parameters.forEach((pname) => retval[pname] = core.getInput(pname));
    Object.keys(Remap).map((pname) => retval[Remap[pname]] = retval[pname]);

    // fix complex parameters
    retval["dryRun"] = retval["dry-run"].toLowerCase() !== "false";
    retval["force"] = retval["force"].toLowerCase() !== "false";
    retval["withV"]  = retval["with-v"].toLowerCase() === "false" ? "" : retval.prefix;

    retval["style"] = Styles.includes(retval["style"]) ? retval["style"] :  "semver";

    // ensure that everything is fine if the user passed an empty list
    retval.issueLabels = retval.labels.split(",").map(label => label.trim());

    if (!retval.issueLabels.length) {
        retval.issueLabels = ["enhancement"];
    }

    return retval;
}

function getDateStyle(style) {
    if (! style.match(/date/) ) {
        return "";
    }

    const now = new Date();

    if (style.match(/iso/)) {
        if (style.match(/datetime/)) {
            return now.toISOString().replace(/:/g,"-").replace(/-\d\d\.\d+Z$/, "");
        }

        return now.toISOString().replace(/:/g,"-").replace(/T.+$/, "");
    }

    let seperator = "";
    let date = [now.getFullYear(), now.getMonth(), now.getDay()];

    if (style.match(/dot/)) {
        seperator = ".";
    }

    if (style.match(/datetime/)) {
        date = date.concat([now.getHour(), now.getMinute()]);
    }

    return date.join(seperator);
}

async function checkTag(octokit, context, tagName) {
    const { data } = await octokit.rest.repos.listTags({
        owner: context.owner,
        repo: context.repo
    });

    if (data) {
        const result = data.filter(tag => tag.name === tagName);

        if (result.length) {
            return true;
        }
    }

    return false;
}

async function getLatestTag(octokit, context, boolAll = true) {
    const { data } = await octokit.rest.repos.listTags({
        owner: context.owner,
        repo: context.repo
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
    // core.info("filter only main releases");

    const filtered = allVTags.filter((b) => semver.prerelease(b.name) === null);
    const result = filtered.pop();

    return result;
}

async function loadBranch(octokit, context, branch) {
    const result = await octokit.rest.git.listMatchingRefs({
        owner: context.owner,
        repo: context.repo,
        ref: `heads/${branch}`
    });

    // core.info(`branch data: ${ JSON.stringify(result.data, undefined, 2) } `);
    return result.data.shift();
}

// FIXME this is messed up!
async function checkMessages(octokit, parameters, context, tagSha) { // tagsha should be terminationSha
    const issueTags = parameters.issueLabels;

    // core.info(`load commits since ${sha}`);

    let releaseBump = "patch";

    const result = await octokit.rest.repos.listCommits({
        owner: context.owner,
        repo: context.repo,
        sha: context.sha
    });

    if (!(result && result.data)) {
        // nothing to do
        return "none";
    }

    const wip   = new RegExp("#wip\\b");
    const major = new RegExp("#major\\b");
    const minor = new RegExp("#minor\\b");
    const patch = new RegExp("#patch\\b");

    const fix   = new RegExp("fix(?:es)? #\\d+");
    const matcher = new RegExp(/fix(?:es)? #(\d+)\b/);

    for (const commit of result.data) {
        // core.info(commit.message);
        const message = commit.commit.message;

        if (commit.sha === tagSha) {
            break;
        }
        // core.info(`commit is : "${JSON.stringify(commit.commit, undefined, 2)}"`);
        // core.info(`message is : "${message}" on ${commit.commit.committer.date} (${commit.sha})`);

        if (wip.test(message)) {
            // core.info("found wip message, skip");
            continue;
        }

        if (major.test(message)) {
            // core.info("found major tag, stop");
            return "major";
        }

        if (minor.test(message)) {
            // core.info("found minor tag");

            releaseBump = "minor";
            continue;
        }

        if (releaseBump !== "minor" && patch.test(message)) {
            // core.info("found patch tag");
            releaseBump = "patch";
            continue;
        }

        if (releaseBump !== "minor" && fix.test(message)) {
            // core.info("found a fix message, check issue for enhancements");

            const id = matcher.exec(message);

            if (id && Number(id[1]) > 0) {
                const issue_number = Number(id[1]);

                core.info(`check issue ${issue_number} for minor labels`);

                const { data } = await octokit.rest.issues.get({
                    owner: context.owner,
                    repo: context.repo,
                    issue_number
                });

                if (data) {
                    releaseBump = "patch";

                    for (const label of data.labels) {

                        if (issueTags.indexOf(label.name) >= 0) {
                            core.info("found enhancement issue");
                            releaseBump = "minor";
                            break;
                        }
                    }
                }
            }

            // continue;
        }
        // core.info("no info message");
    }

    return releaseBump;
}

function isReleaseBranch(currentBranch, allowedBranches) {
    // this algorithm accepts a few extra iterations for the sake of simplicity
    const isReleasable = allowedBranches
        .split(",")
        .map(b => new RegExp(b.trim()).test(currentBranch))
        .filter(e => e);

    return isReleasable.length > 0; // note that more than one patter may match a specific branch.
}

async function verifyBranch(octokit, parameters, context) {

    const forcedBranch = parameters.branch && parameters.branch.length;
    const branch = forcedBranch ? parameters.branch.trim() : context.ref.replace(/refs\/heads\//, "");

    core.info(`check forced branch ${branch}`);

    const branchInfo = await loadBranch(octokit, context.ref, branch);

    if (!branchInfo) {
        throw new Error(`unknown ${ forcedBranch ? "forced " : "" }branch ${branch} provided`);
    }

    return branchInfo;
}

async function applyTag(octokit, context, tag) {
    core.info(`apply new tag ${ tag } to ${ context.repo }`);

    const ref = `refs/tags/${ tag }`;

    await octokit.rest.git.createRef({
        owner: context.owner,
        repo: context.repo,
        ref: ref,
        sha: context.sha
    });
}

async function checkStatic(octokit, parameters, context) {
    const newTag = parameters.tag;

    const doesTagExist = await checkTag(octokit, context, newTag);

    if (doesTagExist) {
        core.info(`tag already exists ${newTag} in ${ context.repo }`);

        if (!parameters.force) {
            return "";
        }
    }

    return newTag;
}

async function checkSemver(octokit, parameters, context) {
    core.info(`check semver tags before ref: ${ context.sha }`);

    const latestTag = await getLatestTag(octokit);
    const latestMainTag = await getLatestTag(octokit, false);
    const versionTag = latestTag && latestTag.name ? latestTag.name : "0.0.0";

    core.info(`the previous tag of the repository ${ JSON.stringify(latestTag, undefined, 2) }`);
    core.info(`the previous main tag of the repository ${ JSON.stringify(latestMainTag, undefined, 2) }`);

    core.setOutput("tag", versionTag);

    if (latestTag && latestTag.commit.sha === context.sha) {
        core.info("no new commits, avoid tagging");
        return "";
    }

    core.info(`The repo tags: ${ JSON.stringify(latestTag, undefined, 2) }`);

    const version   = semver.clean(versionTag);

    // check if commits and issues point to a diffent release level
    // This filters hash tags for major, minor, patch and wip commit messages.
    core.info("check commits in branch");

    const bumpLevel = await checkMessages(
        octokit,
        context.sha, // start with the current commit
        latestMainTag ? latestMainTag.commit.sha : "", // terminate at the previous tag or at the initial commit
        parameters.issueLabels // used for version bump
    );

    if (bumpLevel === "none") {
        core.info("no commit messages found, avoid tagging");
        return "";
    }

    core.info(`commit messages force bump level to ${ bumpLevel }`);
    let nextVersion = semver.inc(version, bumpLevel);

    if (!isReleaseBranch(context.branchName, parameters.releaseBranch)) {
        core.info(`${ context.branchName } is not a release branch, create a prelease tag`);

        // FIXME: Issue 154
        nextVersion = `${ nextVersion }_${context.branchName}`;
    }

    core.info( `bump tag to ${ nextVersion }` );

    // finally we want too verify that the tag does not exist already
    // IMPORTANT: Dont attach the new tag to parameters.tag because of possible side effects!
    return checkStatic(octokit, {tag: nextVersion, force: parameters.force}, context);
}

function chooseTaggingStyle(octokit, parameters, context) {

    // parameters.tag holds a custom tag that overrides the tagging style
    // if the tagging style is not semver, we also use the static versioning
    const checkFunction = parameters.tag || parameters.style !== "semver" ? checkStatic : checkSemver;
    const dateTag = getDateStyle(parameters.style);

    parameters.tag = dateTag === "" ? parameters.tag : dateTag;

    return {
        check: () => checkFunction(octokit, parameters, context),
        apply: (newVersionTag) => applyTag(octokit, context, newVersionTag)
    };
}

async function action() {

    const context = {};

    context.owner = github.context.payload.repository.owner.login;
    context.repo  = github.context.payload.repository.name;
    context.ref  = github.context.ref;

    core.info(`run for ${ context.owner } / ${ context.repo }`);

    const parameters = getParameters();

    // prepare octokit
    const octokit = new github.getOctokit(parameters.token);

    const branchInfo = await verifyBranch(octokit, parameters, context);

    if (!branchInfo) {
        return;
    }

    core.info("branch confirmed, continue");

    // extract commit infos of the active context
    context.sha        = branchInfo.object.sha;
    context.branchName = branchInfo.ref.split("/").pop();

    core.info(`active branch name is ${ context.branchName }`);

    const handler = chooseTaggingStyle(octokit, parameters, context);

    const nextVersion = await handler.check();

    core.setOutput("new-tag", nextVersion);

    if ( !parameters.dryRun && nextVersion ) {
        await handler.apply(nextVersion);
    }
    else {
        core.info("dry run, don't perform tagging");
    }
}

action()
    .then(() => core.info("success"))
    .catch(error => core.setFailed(error.message));
